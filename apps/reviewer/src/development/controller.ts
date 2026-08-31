import type { AppServerNotification, AppServerRequest } from '../codex/app-server.js';
import type { GitHubAppClient } from '../github/client.js';
import type { PullRequestCancellationInput } from '../jobs/database.js';
import type { DevelopmentSandboxManager } from '../sandbox/development.js';
import type {
  DevelopmentAttempt,
  DevelopmentRepository,
} from '../storage/development-repository.js';
import type { DevelopmentResourceRepository } from '../storage/development-resource-repository.js';
import { CodexAppServer } from '../codex/app-server.js';
import { developmentSandboxName } from '../identity.js';
import {
  approvedImplementationPrompt,
  clarificationRequestSchema,
  deferred,
  developmentInstructions,
  executionPhases,
  normalizedNotification,
  observed,
  planRevisionPrompt,
  planningPrompt,
  publicationRevisionPrompt,
  reviewFixPrompt,
  sanitize,
  verificationFixPrompt,
  withTimeout,
} from './controller-support.js';
import { observeDevelopmentPullRequestClosed } from './pull-request-lifecycle.js';
import { DevelopmentResourceLifecycle } from './resource-lifecycle.js';

const leaseMilliseconds = 10 * 60 * 1000;
const turnTimeoutMilliseconds = 30 * 60 * 1000;

export interface DevelopmentReviewFinding {
  evidence: string;
  file: string;
  fingerprint: string;
  line: number;
  title: string;
}

export class DevelopmentController {
  readonly #active = new Map<number, { abort: AbortController; completion: Promise<void> }>();
  readonly #servers = new Map<number, CodexAppServer>();
  readonly #resourceLifecycle: DevelopmentResourceLifecycle;
  readonly #clarifications = new Map<
    number,
    {
      interruptId: number;
      reject: (error: Error) => void;
      resolve: (response: unknown) => void;
    }
  >();

  constructor(
    readonly options: {
      allowedOwnerId: number;
      database: DevelopmentRepository;
      github: GitHubAppClient;
      launchAppServer?: (
        input: Parameters<typeof CodexAppServer.launch>[0],
      ) => ReturnType<typeof CodexAppServer.launch>;
      model: string;
      resources: DevelopmentResourceRepository;
      sandbox: DevelopmentSandboxManager;
      verificationCommand: string;
      workerId: string;
    },
  ) {
    this.#resourceLifecycle = new DevelopmentResourceLifecycle(options);
  }

  get activeRuns(): readonly number[] {
    return [...this.#active.keys()];
  }

  async recover(): Promise<void> {
    this.#resourceLifecycle.reconcileRetained();
    for (const run of this.options.database.listRuns()) {
      if (executionPhases.has(run.phase)) {
        await this.fail(run.id, new Error('development execution was interrupted by restart'));
      }
    }
  }

  startPlanning(runId: number): Promise<void> {
    const current = this.#active.get(runId);
    if (current !== undefined) {
      return current.completion;
    }
    const abort = new AbortController();
    const completion = this.plan(runId, abort.signal)
      .catch((error: unknown) => this.fail(runId, error))
      .finally(() => this.#active.delete(runId));
    this.#active.set(runId, { abort, completion });
    return completion;
  }

  async cancelRun(runId: number): Promise<void> {
    let run = this.options.database.requireRun(runId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.phase)) {
      throw new DevelopmentControllerConflictError(`development run ${runId} is already terminal`);
    }
    const attempt = this.options.database.findActiveAttempt(runId);
    if (attempt?.leaseOwner !== undefined) {
      this.options.database.completeAttempt({
        id: attempt.id,
        runId,
        generation: attempt.generation,
        leaseOwner: attempt.leaseOwner,
        state: 'CANCELLED',
        outcomeCode: 'OPERATOR_CANCELLED',
      });
    }
    run = this.options.database.requireRun(runId);
    this.options.database.cancelRun({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      event: observed('run_cancelled'),
    });
    this.#active.get(runId)?.abort.abort();
    this.#clarifications.get(runId)?.reject(new Error('development run cancelled'));
    await this.#resourceLifecycle.stopAndRetain(runId);
  }

  async cleanupRun(runId: number): Promise<void> {
    await this.#resourceLifecycle.cleanup(runId);
  }

  async stop(): Promise<void> {
    for (const active of this.#active.values()) {
      active.abort.abort();
    }
    for (const server of this.#servers.values()) {
      server.close();
    }
    await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
  }

  approvePlan(input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    approve: boolean;
    response?: string;
  }): Promise<void> {
    if (this.#active.has(input.runId)) {
      throw new DevelopmentControllerConflictError(`development run ${input.runId} is active`);
    }
    const run = this.options.database.requireRun(input.runId);
    if (run.phase !== 'AWAITING_PLAN_APPROVAL') {
      throw new DevelopmentControllerConflictError(
        `development run ${input.runId} is not awaiting plan approval`,
      );
    }
    this.options.database.resolvePlanApproval({
      interruptId: input.interruptId,
      expectedLockVersion: input.interruptLockVersion,
      approve: input.approve,
      ...(input.response === undefined ? {} : { response: input.response }),
    });
    if (!input.approve) {
      const planning = this.options.database.transition({
        id: run.id,
        expectedGeneration: run.generation,
        expectedLockVersion: run.lockVersion,
        phase: 'PLANNING',
        advanceGeneration: true,
        event: observed('plan_rejected', { response: sanitize(input.response ?? '', 4000) }),
      });
      const abort = new AbortController();
      const completion = this.revisePlan(
        planning.id,
        abort.signal,
        planRevisionPrompt(input.response),
      )
        .catch((error: unknown) => this.fail(planning.id, error))
        .finally(() => this.#active.delete(planning.id));
      this.#active.set(planning.id, { abort, completion });
      return completion;
    }
    const implementing = this.options.database.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'IMPLEMENTING',
      advanceGeneration: true,
      event: observed('plan_approved'),
    });
    const abort = new AbortController();
    const completion = this.implement(
      implementing.id,
      abort.signal,
      approvedImplementationPrompt(input.response),
    )
      .catch((error: unknown) => this.fail(implementing.id, error))
      .finally(() => this.#active.delete(implementing.id));
    this.#active.set(implementing.id, { abort, completion });
    return completion;
  }

  approvePublication(input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    candidateHash: string;
    approve: boolean;
    response?: string;
  }): Promise<void> {
    if (this.#active.has(input.runId)) {
      throw new DevelopmentControllerConflictError(`development run ${input.runId} is active`);
    }
    const run = this.options.database.requireRun(input.runId);
    if (
      run.phase !== 'AWAITING_PUBLICATION_APPROVAL' ||
      run.candidateHash !== input.candidateHash
    ) {
      throw new DevelopmentControllerConflictError(
        `development run ${input.runId} is not awaiting this publication candidate`,
      );
    }
    const interrupt = this.options.database.getOpenInterrupt(run.id);
    if (
      interrupt?.id !== input.interruptId ||
      interrupt.kind !== 'PUBLICATION_APPROVAL' ||
      interrupt.candidateHash !== input.candidateHash ||
      interrupt.publicationKind === undefined
    ) {
      throw new DevelopmentControllerConflictError(
        `development run ${input.runId} has no matching publication approval`,
      );
    }
    const publishing = this.options.database.decidePublicationApproval({
      runId: run.id,
      interruptId: input.interruptId,
      expectedInterruptLockVersion: input.interruptLockVersion,
      expectedGeneration: run.generation,
      expectedRunLockVersion: run.lockVersion,
      candidateHash: input.candidateHash,
      approve: input.approve,
      ...(input.response === undefined ? {} : { response: input.response }),
    });
    if (!input.approve) {
      const abort = new AbortController();
      const completion = this.implement(
        publishing.id,
        abort.signal,
        publicationRevisionPrompt(input.response),
      )
        .catch((error: unknown) => this.fail(publishing.id, error))
        .finally(() => this.#active.delete(publishing.id));
      this.#active.set(publishing.id, { abort, completion });
      return completion;
    }
    const abort = new AbortController();
    const completion = this.publish(
      publishing.id,
      input.candidateHash,
      interrupt.publicationKind,
      abort.signal,
    )
      .catch((error: unknown) => this.fail(publishing.id, error))
      .finally(() => this.#active.delete(publishing.id));
    this.#active.set(publishing.id, { abort, completion });
    return completion;
  }

  answerClarification(input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    answers: Record<string, string[]>;
  }): void {
    const pending = this.#clarifications.get(input.runId);
    if (pending === undefined || pending.interruptId !== input.interruptId) {
      throw new DevelopmentControllerConflictError(
        `development run ${input.runId} has no live clarification request`,
      );
    }
    this.options.database.resolveClarification({
      runId: input.runId,
      interruptId: input.interruptId,
      expectedLockVersion: input.interruptLockVersion,
      answers: input.answers,
    });
    pending.resolve({
      answers: Object.fromEntries(
        Object.entries(input.answers).map(([id, answers]) => [id, { answers }]),
      ),
    });
  }

  observeReviewCompleted(input: {
    accepted: boolean;
    findings: DevelopmentReviewFinding[];
    headSha: string;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<void> {
    const run = this.options.database.findRunByPullRequest(input);
    if (run === undefined || run.phase !== 'REVIEWING') {
      return Promise.resolve();
    }
    const pullRequest = this.options.database.getPullRequestReference(run.id);
    if (pullRequest?.headSha !== input.headSha) {
      return Promise.resolve();
    }
    if (input.findings.length === 0) {
      if (!input.accepted) {
        return Promise.resolve();
      }
      this.options.database.transition({
        id: run.id,
        expectedGeneration: run.generation,
        expectedLockVersion: run.lockVersion,
        phase: 'AWAITING_MERGE',
        advanceGeneration: true,
        event: observed('review_passed', {
          head_sha: input.headSha,
          review_job_id: input.jobId,
        }),
      });
      return Promise.resolve();
    }
    if (this.#active.has(run.id)) {
      throw new DevelopmentControllerConflictError(`development run ${run.id} is active`);
    }
    const implementing = this.options.database.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'IMPLEMENTING',
      advanceGeneration: true,
      event: observed('review_findings_received', {
        finding_count: input.findings.length,
        head_sha: input.headSha,
        review_job_id: input.jobId,
      }),
    });
    const abort = new AbortController();
    const completion = this.implement(
      implementing.id,
      abort.signal,
      reviewFixPrompt(input.findings),
    )
      .catch((error: unknown) => this.fail(implementing.id, error))
      .finally(() => this.#active.delete(implementing.id));
    this.#active.set(implementing.id, { abort, completion });
    return completion;
  }

  async observePullRequestClosed(input: PullRequestCancellationInput): Promise<void> {
    await observeDevelopmentPullRequestClosed({
      input,
      database: this.options.database,
      resources: this.#resourceLifecycle,
      stopActive: (runId) => {
        this.#active.get(runId)?.abort.abort();
        this.#clarifications.get(runId)?.reject(new Error('development pull request closed'));
      },
    });
  }

  private async plan(runId: number, signal: AbortSignal): Promise<void> {
    let run = this.options.database.requireRun(runId);
    const repository = this.options.database.getCheckoutSnapshot(runId);
    const readToken = await this.options.github.createRepositoryReadToken({
      allowedOwnerId: this.options.allowedOwnerId,
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
    });
    run = this.options.database.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'PREPARING',
      advanceGeneration: true,
      event: observed('workspace_preparing', { base_sha: repository.baseSha }),
    });
    const preparing = this.claim(run, 'PREPARING', 'DETERMINISTIC');
    const branch = `codex/development-${run.id}`;
    this.#resourceLifecycle.observePreparing(run.id, run.generation);
    const sandbox = await this.options.sandbox.prepare({
      runId: run.id,
      branch,
      cloneUrl: repository.cloneUrl,
      baseSha: repository.baseSha,
      readToken,
      signal,
    });
    this.#resourceLifecycle.observeActive(run.id, run.generation);
    this.options.database.completeAttempt({
      id: preparing.id,
      runId: run.id,
      generation: run.generation,
      leaseOwner: this.options.workerId,
      state: 'SUCCEEDED',
      outcomeCode: 'WORKSPACE_READY',
    });
    run = this.options.database.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: this.options.database.requireRun(run.id).lockVersion,
      phase: 'PLANNING',
      advanceGeneration: true,
      event: observed('planning_started', { branch }),
    });
    const planning = this.claim(run, 'PLANNING', 'CODEX_APP_SERVER');
    const completed = deferred<void>();
    let server: CodexAppServer | undefined;
    try {
      const launch = this.options.launchAppServer ?? ((input) => CodexAppServer.launch(input));
      server = await launch({
        sandboxName: sandbox.name,
        workspaceDirectory: sandbox.workspaceDirectory,
        onNotification: (notification) => {
          this.recordNotification(runId, run.generation, planning.id, notification);
          if (notification.method === 'turn/completed') {
            completed.resolve();
          }
        },
        onRequest: (request) =>
          this.handleClarification(run.id, run.generation, planning.id, 'PLANNING', request),
      });
      this.#servers.set(run.id, server);
      await server.setSkillRoots([sandbox.skillsDirectory]);
      const commitSkill = (await server.listSkills(sandbox.workspaceDirectory)).find(
        (skill) => skill.name === 'commit' && skill.enabled,
      );
      if (commitSkill === undefined) {
        throw new Error('run-specific commit skill is unavailable');
      }
      const threadId = await server.startThread({
        cwd: sandbox.workspaceDirectory,
        model: this.options.model,
        developerInstructions: developmentInstructions,
      });
      this.options.database.attachAttemptRuntime({
        id: planning.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        threadId,
      });
      const turnId = await server.startTurn({
        threadId,
        prompt: planningPrompt(run.goal),
      });
      this.options.database.attachAttemptRuntime({
        id: planning.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        threadId,
        turnId,
      });
      await withTimeout(
        completed.promise,
        turnTimeoutMilliseconds,
        'planning turn timed out',
        signal,
      );
      this.options.database.completeAttempt({
        id: planning.id,
        runId: run.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        state: 'SUCCEEDED',
        outcomeCode: 'PLAN_PROPOSED',
      });
      const current = this.options.database.requireRun(run.id);
      this.options.database.requestPlanApproval({
        runId: current.id,
        workRevisionId: current.workRevisionId,
        expectedGeneration: current.generation,
        expectedLockVersion: current.lockVersion,
        prompt: 'Approve this implementation plan?',
      });
    } finally {
      this.#servers.delete(run.id);
      server?.close();
      await this.#resourceLifecycle.stopAndRetain(run.id);
    }
  }

  private async revisePlan(runId: number, signal: AbortSignal, prompt: string): Promise<void> {
    const run = this.options.database.requireRun(runId);
    const attempt = this.claim(run, 'PLANNING', 'CODEX_APP_SERVER');
    const paths = this.options.sandbox.paths(runId, false);
    const threadId = this.options.database.findLatestThreadId(runId);
    if (threadId === undefined) {
      throw new Error('development run has no resumable Codex thread');
    }
    const completed = deferred<void>();
    let server: CodexAppServer | undefined;
    try {
      const launch = this.options.launchAppServer ?? ((input) => CodexAppServer.launch(input));
      server = await launch({
        sandboxName: developmentSandboxName(runId),
        workspaceDirectory: paths.workspaceDirectory,
        onNotification: (notification) => {
          this.recordNotification(runId, run.generation, attempt.id, notification);
          if (notification.method === 'turn/completed') {
            completed.resolve();
          }
        },
        onRequest: (request) =>
          this.handleClarification(run.id, run.generation, attempt.id, 'PLANNING', request),
      });
      this.#servers.set(run.id, server);
      await server.resumeThread({ threadId, cwd: paths.workspaceDirectory });
      const turnId = await server.startTurn({ threadId, prompt });
      this.options.database.attachAttemptRuntime({
        id: attempt.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        threadId,
        turnId,
      });
      await withTimeout(
        completed.promise,
        turnTimeoutMilliseconds,
        'planning revision turn timed out',
        signal,
      );
      this.options.database.completeAttempt({
        id: attempt.id,
        runId,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        state: 'SUCCEEDED',
        outcomeCode: 'PLAN_REVISED',
      });
      const current = this.options.database.requireRun(run.id);
      this.options.database.requestPlanApproval({
        runId: current.id,
        workRevisionId: current.workRevisionId,
        expectedGeneration: current.generation,
        expectedLockVersion: current.lockVersion,
        prompt: 'Approve this revised implementation plan?',
      });
    } finally {
      this.#servers.delete(run.id);
      server?.close();
      await this.#resourceLifecycle.stopAndRetain(run.id);
    }
  }

  private async implement(runId: number, signal: AbortSignal, prompt: string): Promise<void> {
    let run = this.options.database.requireRun(runId);
    const attempt = this.options.database.claimAttempt({
      runId,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'IMPLEMENTING',
      executorKind: 'CODEX_APP_SERVER',
      leaseOwner: this.options.workerId,
      leaseExpiresAt: new Date(Date.now() + leaseMilliseconds).toISOString(),
    });
    const paths = this.options.sandbox.paths(runId, false);
    const threadId = this.options.database.findLatestThreadId(runId);
    if (threadId === undefined) {
      throw new Error('development run has no resumable Codex thread');
    }
    const completed = deferred<void>();
    let server: CodexAppServer | undefined;
    try {
      const launch = this.options.launchAppServer ?? ((input) => CodexAppServer.launch(input));
      server = await launch({
        sandboxName: developmentSandboxName(runId),
        workspaceDirectory: paths.workspaceDirectory,
        onNotification: (notification) => {
          this.recordNotification(runId, run.generation, attempt.id, notification);
          if (notification.method === 'turn/completed') {
            completed.resolve();
          }
        },
        onRequest: (request) =>
          this.handleClarification(run.id, run.generation, attempt.id, 'IMPLEMENTING', request),
      });
      this.#servers.set(run.id, server);
      await server.setSkillRoots([paths.skillsDirectory]);
      const commitSkill = (await server.listSkills(paths.workspaceDirectory)).find(
        (skill) => skill.name === 'commit' && skill.enabled,
      );
      if (commitSkill === undefined) {
        throw new Error('run-specific commit skill is unavailable');
      }
      await server.resumeThread({ threadId, cwd: paths.workspaceDirectory });
      const turnId = await server.startTurn({
        threadId,
        prompt,
        skills: [{ name: commitSkill.name, path: commitSkill.path }],
      });
      this.options.database.attachAttemptRuntime({
        id: attempt.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        threadId,
        turnId,
      });
      await withTimeout(
        completed.promise,
        turnTimeoutMilliseconds,
        'implementation turn timed out',
        signal,
      );
      this.options.database.completeAttempt({
        id: attempt.id,
        runId,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        state: 'SUCCEEDED',
        outcomeCode: 'IMPLEMENTATION_COMPLETED',
      });
    } finally {
      this.#servers.delete(run.id);
      server?.close();
    }

    const candidate = await this.options.sandbox.candidateIdentity(runId);
    if (candidate.dirty) {
      throw new Error('implementation candidate must be committed before verification');
    }
    run = this.options.database.setCandidate({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: this.options.database.requireRun(run.id).lockVersion,
      candidateHash: candidate.hash,
      event: observed('candidate_observed', {
        dirty: candidate.dirty,
        head_sha: candidate.headSha,
      }),
    });
    await this.verifyCandidate(run, candidate.hash, signal);
  }

  private async verifyCandidate(
    inputRun: ReturnType<DevelopmentRepository['requireRun']>,
    candidateHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    let run = this.options.database.transition({
      id: inputRun.id,
      expectedGeneration: inputRun.generation,
      expectedLockVersion: inputRun.lockVersion,
      phase: 'VERIFYING',
      advanceGeneration: true,
      event: observed('verification_started', { command: this.options.verificationCommand }),
    });
    const attempt = this.options.database.claimAttempt({
      runId: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'VERIFYING',
      executorKind: 'DETERMINISTIC',
      leaseOwner: this.options.workerId,
      leaseExpiresAt: new Date(Date.now() + leaseMilliseconds).toISOString(),
    });
    try {
      await this.options.sandbox.runVerification(run.id, this.options.verificationCommand);
      const verified = await this.options.sandbox.candidateIdentity(run.id);
      if (verified.hash !== candidateHash) {
        throw new Error('candidate changed during deterministic verification');
      }
      this.options.database.recordEvidence({
        runId: run.id,
        workRevisionId: run.workRevisionId,
        generation: run.generation,
        candidateHash,
        criterion: 'Configured repository verification passes without candidate drift.',
        method: 'COMMAND',
        observation: 'The configured verification command exited successfully.',
        commandOrArtifact: this.options.verificationCommand,
        resultCode: '0',
        trust: 'SYSTEM_OBSERVED',
        verdict: 'PASSED',
      });
      this.options.database.completeAttempt({
        id: attempt.id,
        runId: run.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        state: 'SUCCEEDED',
        outcomeCode: 'VERIFICATION_PASSED',
      });
    } catch (error) {
      this.options.database.recordEvidence({
        runId: run.id,
        workRevisionId: run.workRevisionId,
        generation: run.generation,
        candidateHash,
        criterion: 'Configured repository verification passes without candidate drift.',
        method: 'COMMAND',
        observation: sanitize(error instanceof Error ? error.message : String(error), 4000),
        commandOrArtifact: this.options.verificationCommand,
        trust: 'SYSTEM_OBSERVED',
        verdict: 'FAILED',
      });
      this.options.database.completeAttempt({
        id: attempt.id,
        runId: run.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        state: 'FAILED',
        outcomeCode: 'VERIFICATION_FAILED',
      });
      run = this.options.database.requireRun(run.id);
      const implementing = this.options.database.transition({
        id: run.id,
        expectedGeneration: run.generation,
        expectedLockVersion: run.lockVersion,
        phase: 'IMPLEMENTING',
        advanceGeneration: true,
        event: observed('verification_failed'),
      });
      await this.implement(implementing.id, signal, verificationFixPrompt(error));
      return;
    }
    run = this.options.database.requireRun(run.id);
    const publicationKind =
      this.options.database.getPullRequestReference(run.id) === undefined
        ? 'PUSH_AND_PR'
        : 'PUSH_EXISTING';
    this.options.database.requestPublicationApproval({
      runId: run.id,
      workRevisionId: run.workRevisionId,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      candidateHash,
      publicationKind,
      prompt:
        publicationKind === 'PUSH_AND_PR'
          ? 'Publish this exact verified candidate by pushing its branch and creating a pull request?'
          : 'Publish this exact verified candidate by pushing one update to the existing pull request?',
    });
    await this.#resourceLifecycle.stopAndRetain(run.id);
  }

  private async publish(
    runId: number,
    approvedCandidateHash: string,
    publicationKind: 'PUSH_AND_PR' | 'PUSH_EXISTING',
    signal: AbortSignal,
  ): Promise<void> {
    let run = this.options.database.requireRun(runId);
    const attempt = this.options.database.claimAttempt({
      runId,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'PUBLISHING',
      executorKind: 'CODEX_APP_SERVER',
      leaseOwner: this.options.workerId,
      leaseExpiresAt: new Date(Date.now() + leaseMilliseconds).toISOString(),
    });
    const paths = this.options.sandbox.paths(runId, false);
    const threadId = this.options.database.findLatestThreadId(runId);
    if (threadId === undefined) {
      throw new Error('development run has no resumable Codex thread');
    }
    const repository = await this.options.github.getRepository({
      allowedOwnerId: this.options.allowedOwnerId,
      repository: run.repository,
    });
    const branch = `codex/development-${run.id}`;
    const completed = deferred<void>();
    let server: CodexAppServer | undefined;
    let publicationError: unknown;
    let publicationCapabilityAttempted = false;
    let publicationRevocationError: unknown;
    let observedPullRequest:
      | Awaited<ReturnType<GitHubAppClient['findOpenPullRequest']>>
      | undefined;
    try {
      publicationCapabilityAttempted = true;
      await this.options.sandbox.enablePublication(runId);
      const launch = this.options.launchAppServer ?? ((input) => CodexAppServer.launch(input));
      server = await launch({
        sandboxName: developmentSandboxName(runId),
        workspaceDirectory: paths.workspaceDirectory,
        onNotification: (notification) => {
          this.recordNotification(runId, run.generation, attempt.id, notification);
          if (notification.method === 'turn/completed') {
            completed.resolve();
          }
        },
        onRequest: (request) =>
          Promise.reject(new Error(`publication request ${request.method} is not authorized`)),
      });
      this.#servers.set(run.id, server);
      await server.setSkillRoots([paths.skillsDirectory]);
      const createPrSkill =
        publicationKind === 'PUSH_AND_PR'
          ? (await server.listSkills(paths.workspaceDirectory)).find(
              (skill) => skill.name === 'create-pr' && skill.enabled,
            )
          : undefined;
      if (publicationKind === 'PUSH_AND_PR' && createPrSkill === undefined) {
        throw new Error('run-specific create-pr skill is unavailable');
      }
      await server.resumeThread({ threadId, cwd: paths.workspaceDirectory });
      const turnId = await server.startTurn({
        threadId,
        prompt:
          publicationKind === 'PUSH_AND_PR'
            ? `The operator approved one publication of candidate ${approvedCandidateHash}. Use the supplied create-pr skill to push branch ${branch} and create its pull request. Do not modify source, create another branch, merge, deploy, or perform any other external write.`
            : `The operator approved one update of existing pull request branch ${branch} at candidate ${approvedCandidateHash}. Push that exact branch once. Do not create another pull request, modify source, merge, deploy, or perform any other external write.`,
        ...(createPrSkill === undefined
          ? {}
          : { skills: [{ name: createPrSkill.name, path: createPrSkill.path }] }),
      });
      this.options.database.attachAttemptRuntime({
        id: attempt.id,
        generation: run.generation,
        leaseOwner: this.options.workerId,
        threadId,
        turnId,
      });
      await withTimeout(
        completed.promise,
        turnTimeoutMilliseconds,
        'publication turn timed out',
        signal,
      );
      const candidate = await this.options.sandbox.candidateIdentity(runId);
      if (candidate.hash !== approvedCandidateHash || candidate.dirty) {
        throw new Error('publication turn changed the approved candidate');
      }
      const pullRequest = await this.options.github.findOpenPullRequest({
        installationId: repository.installationId,
        repository: run.repository,
        branch,
      });
      if (pullRequest === undefined || pullRequest.headSha !== candidate.headSha) {
        throw new Error('approved pull request publication was not observed on GitHub');
      }
      this.options.database.recordPullRequest({
        runId,
        generation: run.generation,
        number: pullRequest.number,
        url: pullRequest.url,
        headSha: pullRequest.headSha,
      });
      observedPullRequest = pullRequest;
    } catch (error) {
      publicationError = error;
    } finally {
      this.#servers.delete(run.id);
      server?.close();
      if (publicationCapabilityAttempted) {
        try {
          await this.options.sandbox.disablePublication(runId);
        } catch (error) {
          publicationRevocationError = error;
        }
      }
      if (publicationRevocationError === undefined) {
        await this.#resourceLifecycle.stopAndRetain(runId);
      }
    }
    if (publicationRevocationError !== undefined) {
      await this.#resourceLifecycle.quarantinePublicationFailure(runId, publicationRevocationError);
      throw new Error(
        `publication capability revocation failed: ${sanitize(publicationRevocationError instanceof Error ? publicationRevocationError.message : 'unknown revocation failure', 4000)}`,
        { cause: publicationRevocationError },
      );
    }
    if (publicationError !== undefined) {
      throw publicationError instanceof Error
        ? publicationError
        : new Error('unknown publication failure');
    }
    if (observedPullRequest === undefined) {
      throw new Error('published pull request observation was lost');
    }
    this.options.database.completeAttempt({
      id: attempt.id,
      runId,
      generation: run.generation,
      leaseOwner: this.options.workerId,
      state: 'SUCCEEDED',
      outcomeCode: 'PULL_REQUEST_OBSERVED',
    });
    run = this.options.database.requireRun(runId);
    this.options.database.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'REVIEWING',
      advanceGeneration: true,
      event: observed('review_wait_started', { pull_request: observedPullRequest.number }),
    });
  }

  private claim(
    run: ReturnType<DevelopmentRepository['requireRun']>,
    phase: 'PREPARING' | 'PLANNING',
    executorKind: 'CODEX_APP_SERVER' | 'DETERMINISTIC',
  ): DevelopmentAttempt {
    return this.options.database.claimAttempt({
      runId: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase,
      executorKind,
      leaseOwner: this.options.workerId,
      leaseExpiresAt: new Date(Date.now() + leaseMilliseconds).toISOString(),
    });
  }

  private async handleClarification(
    runId: number,
    generation: number,
    attemptId: number,
    phase: 'PLANNING' | 'IMPLEMENTING',
    request: AppServerRequest,
  ): Promise<unknown> {
    if (request.method !== 'item/tool/requestUserInput') {
      throw new Error(`App Server request ${request.method} is not authorized`);
    }
    if (this.#clarifications.has(runId)) {
      throw new Error(`development run ${runId} already has a pending clarification`);
    }
    const parsed = clarificationRequestSchema.parse(request.params);
    if (new Set(parsed.questions.map((question) => question.id)).size !== parsed.questions.length) {
      throw new Error('clarification question identifiers must be unique');
    }
    if (parsed.questions.some((question) => question.isSecret)) {
      throw new Error('secret user input is not supported by the development web surface');
    }
    const run = this.options.database.requireRun(runId);
    if (run.generation !== generation || run.phase !== phase) {
      throw new DevelopmentControllerConflictError(
        `clarification request for development run ${runId} is stale`,
      );
    }
    const questions = parsed.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      ...(question.options === null ? {} : { options: question.options }),
    }));
    const interruptId = this.options.database.requestClarification({
      runId,
      attemptId,
      workRevisionId: run.workRevisionId,
      generation,
      expectedLockVersion: run.lockVersion,
      phase,
      requestId: String(request.id),
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      questions,
      prompt: questions.map((question) => `${question.header}: ${question.question}`).join('\n'),
    });
    const response = deferred<unknown>();
    this.#clarifications.set(runId, {
      interruptId,
      reject: response.reject,
      resolve: response.resolve,
    });
    try {
      return await response.promise;
    } finally {
      this.#clarifications.delete(runId);
    }
  }

  private recordNotification(
    runId: number,
    generation: number,
    attemptId: number,
    notification: AppServerNotification,
  ): void {
    const event = normalizedNotification(notification);
    if (event === undefined) {
      return;
    }
    try {
      this.options.database.appendEvent(runId, generation, { ...event, attemptId });
    } catch {
      // A stale process may still emit diagnostics after fencing. It must not mutate current state.
    }
  }

  private async fail(runId: number, error: unknown): Promise<void> {
    this.#clarifications
      .get(runId)
      ?.reject(error instanceof Error ? error : new Error(String(error)));
    let run = this.options.database.getRun(runId);
    if (run === undefined || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.phase)) {
      return;
    }
    try {
      const attempt = this.options.database.findActiveAttempt(runId);
      if (attempt?.leaseOwner !== undefined) {
        this.options.database.completeAttempt({
          id: attempt.id,
          runId,
          generation: attempt.generation,
          leaseOwner: attempt.leaseOwner,
          state: 'LOST',
          outcomeCode: 'CONTROLLER_ERROR',
          outcomeExcerpt: sanitize(error instanceof Error ? error.message : String(error), 4000),
        });
      }
      run = this.options.database.requireRun(runId);
      this.options.database.transition({
        id: run.id,
        expectedGeneration: run.generation,
        expectedLockVersion: run.lockVersion,
        phase: 'FAILED',
        event: observed('run_failed', {
          error: sanitize(error instanceof Error ? error.message : String(error), 4000),
        }),
      });
    } catch {
      // A newer generation owns the run; the stale failure is intentionally ignored.
    }
    await this.#resourceLifecycle.stopAndRetain(runId).catch(() => {
      // The lifecycle records UNKNOWN or CLEANUP_FAILED before throwing; the failed run remains inspectable.
    });
  }
}

export class DevelopmentControllerConflictError extends Error {}
