import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionTraceStore } from '../execution/trace.js';
import { CodexExecutionRecorder } from '../execution/codex-events.js';
import { reviewProtocol, reviewerSandboxName } from '../identity.js';
import { type ReviewableLines, parseReviewableLines } from '../review/diff-lines.js';
import {
  type ReviewResult,
  findingFingerprint,
  removePreviouslyReportedFindings,
  reviewResultSchema,
  validateFindingUpdates,
} from '../review/result.js';
import { runProcess, runStreamingProcess } from '../system/process.js';
import {
  inspectSandboxRuntime,
  probeSandboxEnvironment,
  sandboxCreateArguments,
} from './runtime.js';

interface SandboxReview {
  path: string;
  result: ReviewResult;
  reviewMode: 'full' | 'incremental';
  reviewableLines: ReviewableLines;
}

export class SandboxReviewer {
  constructor(
    readonly options: {
      model: string;
      reasoningEffort: string;
      resourcesDirectory: string;
      sandboxTemplate: string;
      traceStore: ExecutionTraceStore;
    },
  ) {}

  async review(input: {
    baseRef: string;
    baseSha: string;
    cloneUrl: string;
    headSha: string;
    installationToken: string;
    attempt: number;
    jobDirectory: string;
    jobId: number;
    policyInstructions?: readonly string[];
    previousResult?: ReviewResult;
    reviewBaseSha: string;
    reviewMode: 'full' | 'incremental';
    pullRequestNumber: number;
    repository: string;
    signal: AbortSignal;
    title: string;
    onPromptPrepared?: (snapshot: {
      model: string;
      reasoning: string;
      prompt: string;
      schema: string;
    }) => void;
  }): Promise<SandboxReview> {
    const sandboxName = reviewerSandboxName(input.jobId);
    const sandboxOutputPath = reviewProtocol.sandboxOutputPath;
    const sandboxAnchor = join(input.jobDirectory, 'sandbox-anchor');
    const stagedResourcesDirectory = join(input.jobDirectory, 'review-resources');
    const schemaPath = join(stagedResourcesDirectory, 'review-schema.json');
    const promptTemplate = readFileSync(
      join(this.options.resourcesDirectory, 'review-prompt.md'),
      'utf8',
    );

    mkdirSync(sandboxAnchor, { recursive: true, mode: 0o700 });
    mkdirSync(stagedResourcesDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(join(this.options.resourcesDirectory, 'review-schema.json'), schemaPath);
    copyFileSync(
      join(this.options.resourcesDirectory, 'review-prompt.md'),
      join(stagedResourcesDirectory, 'review-prompt.md'),
    );
    const recorder = new CodexExecutionRecorder(
      this.options.traceStore,
      input.jobId,
      input.attempt,
    );

    try {
      const runtime = await inspectSandboxRuntime(this.options.sandboxTemplate);
      this.options.traceStore.append(input.jobId, input.attempt, {
        type: 'sandbox_environment',
        status: 'configured',
        message: `template=${runtime.template}\nsbx=${runtime.cliVersion}\nshared_skills=requested_disabled`,
      });
      await runProcess(
        'sbx',
        sandboxCreateArguments({
          name: sandboxName,
          template: this.options.sandboxTemplate,
          workspaces: [sandboxAnchor, `${stagedResourcesDirectory}:ro`],
        }),
        {
          signal: input.signal,
          timeoutMilliseconds: 5 * 60 * 1000,
        },
      );
      const baseline = await probeSandboxEnvironment(sandboxName, input.signal);
      this.options.traceStore.append(input.jobId, input.attempt, {
        type: 'sandbox_environment',
        status: 'ready',
        message: baseline,
      });
      await checkoutPullRequestInSandbox({
        baseSha: input.baseSha,
        cloneUrl: input.cloneUrl,
        headSha: input.headSha,
        installationToken: input.installationToken,
        pullRequestNumber: input.pullRequestNumber,
        sandboxName,
        signal: input.signal,
      });

      const checkedOutHead = (
        await runSandboxGit(sandboxName, ['rev-parse', 'HEAD'], input.signal)
      ).stdout.trim();
      if (checkedOutHead !== input.headSha) {
        throw new Error(`checked out ${checkedOutHead}, expected ${input.headSha}`);
      }

      let previousResult = input.previousResult;
      let reviewBaseSha = input.reviewBaseSha;
      let reviewMode = input.reviewMode;
      if (
        reviewMode === 'incremental' &&
        !(await isAncestorInSandbox(sandboxName, reviewBaseSha, input.headSha, input.signal))
      ) {
        console.warn(
          `previous review ${reviewBaseSha} is not an ancestor of ${input.headSha}; falling back to full review`,
        );
        previousResult = undefined;
        reviewBaseSha = input.baseSha;
        reviewMode = 'full';
      }

      const diff = await runSandboxGit(
        sandboxName,
        [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--unified=0',
          `${input.baseSha}...${input.headSha}`,
          '--',
        ],
        input.signal,
      );
      const reviewableLines = parseReviewableLines(diff.stdout);
      const changedFiles =
        reviewMode === 'incremental'
          ? new Set(
              (
                await runSandboxGit(
                  sandboxName,
                  ['diff', '--name-only', `${reviewBaseSha}...${input.headSha}`],
                  input.signal,
                )
              ).stdout
                .split('\n')
                .filter((path) => path.length > 0),
            )
          : new Set<string>();
      const previousContext =
        previousResult === undefined
          ? ''
          : `\n\nPreviously reported findings:\n\`\`\`json\n${JSON.stringify(
              previousResult.findings.map((finding) => ({
                ...finding,
                fingerprint: findingFingerprint(finding),
              })),
              null,
              2,
            )}\n\`\`\`\nDo not report these findings again unless the new commits introduce a materially different defect.`;
      const boundaryInstruction =
        reviewMode === 'full'
          ? `Use \`git diff ${input.baseSha}...${input.headSha}\` as the review boundary.`
          : `This is an incremental review. Focus on defects introduced by \`git diff ${reviewBaseSha}...${input.headSha}\`. You may inspect the full pull request diff and repository for context, but return only new findings introduced after ${reviewBaseSha}.`;
      const policyContext =
        input.policyInstructions === undefined || input.policyInstructions.length === 0
          ? ''
          : `\n\nRepository review policy (from the default branch):\n${input.policyInstructions.map((instruction) => `- ${instruction}`).join('\n')}`;
      const prompt = `${promptTemplate}\n\nPull request context:\n- Repository: ${input.repository}\n- Pull request: #${input.pullRequestNumber}\n- Title: ${input.title}\n- Review mode: ${reviewMode}\n- Base ref: ${input.baseRef}\n- Base SHA: ${input.baseSha}\n- Review base SHA: ${reviewBaseSha}\n- Head SHA: ${input.headSha}\n\n${boundaryInstruction}${policyContext}${previousContext}`;
      input.onPromptPrepared?.({
        model: this.options.model,
        reasoning: this.options.reasoningEffort,
        prompt,
        schema: readFileSync(join(this.options.resourcesDirectory, 'review-schema.json'), 'utf8'),
      });

      recorder.start();
      try {
        await runStreamingProcess(
          'sbx',
          [
            'exec',
            '-i',
            '-w',
            reviewProtocol.sandboxWorkspace,
            sandboxName,
            'codex',
            'exec',
            '--model',
            this.options.model,
            '--config',
            `model_reasoning_effort="${this.options.reasoningEffort}"`,
            '--dangerously-bypass-approvals-and-sandbox',
            '--ephemeral',
            '--ignore-rules',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            sandboxOutputPath,
            '--json',
            '-',
          ],
          {
            input: prompt,
            onStdout: (chunk) => recorder.write(chunk),
            signal: input.signal,
            timeoutMilliseconds: 30 * 60 * 1000,
          },
        );
      } finally {
        recorder.stop();
      }

      const output = await runProcess('sbx', ['exec', sandboxName, 'cat', sandboxOutputPath], {
        signal: input.signal,
        timeoutMilliseconds: 60_000,
      });
      const rawResult = reviewResultSchema.parse(JSON.parse(output.stdout));
      const validatedResult = validateFindingUpdates(rawResult, previousResult);
      const result = removePreviouslyReportedFindings(
        validatedResult,
        previousResult,
        changedFiles,
      );
      const resultPath = join(input.jobDirectory, 'review-result.json');
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
        mode: 0o600,
      });
      return { path: resultPath, result, reviewMode, reviewableLines };
    } finally {
      recorder.stop();
      await runProcess('sbx', ['rm', '--force', sandboxName], {
        timeoutMilliseconds: 2 * 60 * 1000,
      }).catch(() => undefined);
      rmSync(sandboxAnchor, { force: true, recursive: true });
    }
  }
}

export async function checkoutPullRequestInSandbox(input: {
  baseSha: string;
  cloneUrl: string;
  headSha: string;
  installationToken: string;
  pullRequestNumber: number;
  sandboxName: string;
  signal: AbortSignal;
}): Promise<void> {
  await runProcess(
    'sbx',
    [
      'exec',
      input.sandboxName,
      'sh',
      '-ceu',
      'mkdir -p "$1" && git -C "$1" init --initial-branch=review && git -C "$1" remote add origin "$2"',
      'sh',
      reviewProtocol.sandboxWorkspace,
      input.cloneUrl,
    ],
    { signal: input.signal },
  );
  await runProcess(
    'sbx',
    [
      'exec',
      '-i',
      input.sandboxName,
      'sh',
      '-ceu',
      'IFS= read -r token; authorization=$(printf "x-access-token:%s" "$token" | base64 | tr -d "\\n"); export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $authorization"; git -C "$1" fetch --no-tags "$2" "$3" "$4"; git -C "$1" checkout --detach refs/review/head',
      'sh',
      reviewProtocol.sandboxWorkspace,
      'origin',
      `+${input.baseSha}:refs/review/base`,
      `+refs/pull/${input.pullRequestNumber}/head:refs/review/head`,
    ],
    { input: `${input.installationToken}\n`, signal: input.signal },
  );
}

async function isAncestorInSandbox(
  sandboxName: string,
  ancestor: string,
  descendant: string,
  signal: AbortSignal,
): Promise<boolean> {
  return runSandboxGit(sandboxName, ['merge-base', '--is-ancestor', ancestor, descendant], signal)
    .then(() => true)
    .catch(() => false);
}

function runSandboxGit(sandboxName: string, arguments_: readonly string[], signal: AbortSignal) {
  return runProcess(
    'sbx',
    ['exec', '-w', reviewProtocol.sandboxWorkspace, sandboxName, 'git', ...arguments_],
    {
      signal,
    },
  );
}
