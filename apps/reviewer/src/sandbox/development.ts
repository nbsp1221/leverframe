import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { developmentProtocol, developmentSandboxName } from '../identity.js';
import { runProcess } from '../system/process.js';
import { probeSandboxEnvironment, sandboxCreateArguments } from './runtime.js';

export interface DevelopmentSandbox {
  name: string;
  branch: string;
  workspaceDirectory: string;
  skillsDirectory: string;
}

export class DevelopmentSandboxManager {
  readonly #developmentRoot: string;

  constructor(
    readonly options: {
      dataDirectory: string;
      sandboxTemplate: string;
      commitSkillDirectory: string;
      createPrSkillDirectory: string;
    },
  ) {
    mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    this.#developmentRoot = resolve(options.dataDirectory, 'development');
    mkdirSync(this.#developmentRoot, { recursive: true, mode: 0o700 });
  }

  async prepare(input: {
    runId: number;
    branch: string;
    cloneUrl: string;
    baseSha: string;
    readToken: string;
    signal?: AbortSignal;
  }): Promise<DevelopmentSandbox> {
    assertTaskBranch(input.branch);
    assertCommitSha(input.baseSha);
    assertCredentialFreeRemote(input.cloneUrl);
    const paths = this.paths(input.runId, true);
    this.snapshotSkill(paths.skillsDirectory, 'commit', this.options.commitSkillDirectory);
    const name = developmentSandboxName(input.runId);
    await runProcess(
      'sbx',
      sandboxCreateArguments({
        name,
        template: this.options.sandboxTemplate,
        workspaces: [paths.workspaceDirectory, `${paths.skillsDirectory}:ro`],
      }),
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMilliseconds: 5 * 60 * 1000,
      },
    );
    try {
      await probeSandboxEnvironment(name, input.signal);
      await this.checkoutBase({ ...input, name, workspaceDirectory: paths.workspaceDirectory });
    } finally {
      await this.denyGitHub(name);
    }
    const observed = await this.observe(input.runId, input.signal);
    if (observed.branch !== input.branch || observed.headSha !== input.baseSha) {
      throw new Error(
        'development workspace identity does not match the requested branch and base',
      );
    }
    return { name, branch: input.branch, ...paths };
  }

  async observe(
    runId: number,
    signal?: AbortSignal,
  ): Promise<{ branch: string; headSha: string; dirty: boolean }> {
    const paths = this.paths(runId, false);
    const name = developmentSandboxName(runId);
    const result = await runProcess(
      'sbx',
      [
        'exec',
        '-w',
        paths.workspaceDirectory,
        name,
        'git',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
      ],
      signal === undefined ? {} : { signal },
    );
    return parseWorkspaceStatus(result.stdout);
  }

  async stop(runId: number): Promise<void> {
    await runProcess('sbx', ['stop', developmentSandboxName(runId)], {
      timeoutMilliseconds: 2 * 60 * 1000,
    });
  }

  async candidateIdentity(runId: number): Promise<{
    hash: string;
    headSha: string;
    dirty: boolean;
  }> {
    const paths = this.paths(runId, false);
    const name = developmentSandboxName(runId);

    const git = async (arguments_: readonly string[]) =>
      runProcess('sbx', ['exec', '-w', paths.workspaceDirectory, name, 'git', ...arguments_]);

    const [head, status, unstaged, staged, submodules, untracked] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
      git(['diff', '--binary', '--no-ext-diff']),
      git(['diff', '--cached', '--binary', '--no-ext-diff']),
      git(['submodule', 'status', '--recursive']),
      runProcess('sbx', [
        'exec',
        '-w',
        paths.workspaceDirectory,
        name,
        'sh',
        '-ceu',
        'git ls-files --others --exclude-standard -z | sort -z | xargs -0 -r sha256sum --zero',
      ]),
    ]);
    const parsed = parseWorkspaceStatus(status.stdout.replaceAll('\0', '\n'));
    const hash = createHash('sha256')
      .update('leverframe-candidate-v1\0')
      .update(head.stdout.trim())
      .update('\0')
      .update(status.stdout)
      .update('\0')
      .update(unstaged.stdout)
      .update('\0')
      .update(staged.stdout)
      .update('\0')
      .update(submodules.stdout)
      .update('\0')
      .update(untracked.stdout)
      .digest('hex');
    return { hash, headSha: head.stdout.trim(), dirty: parsed.dirty };
  }

  async runVerification(
    runId: number,
    command: string,
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    if (command.trim() === '' || command.length > 2000) {
      throw new Error('development verification command is invalid');
    }
    const paths = this.paths(runId, false);
    return runProcess(
      'sbx',
      [
        'exec',
        '-w',
        paths.workspaceDirectory,
        developmentSandboxName(runId),
        'sh',
        '-ceu',
        command,
      ],
      { timeoutMilliseconds: 30 * 60 * 1000 },
    );
  }

  async enablePublication(runId: number): Promise<void> {
    const name = developmentSandboxName(runId);
    const paths = this.paths(runId, false);
    this.snapshotSkill(paths.skillsDirectory, 'create-pr', this.options.createPrSkillDirectory);
    await runProcess('sbx', [
      'policy',
      'rm',
      'network',
      '--sandbox',
      name,
      '--resource',
      'github.com,api.github.com',
    ]);
    try {
      await runProcess('sbx', [
        'secret',
        'set',
        'github',
        '--sandbox',
        name,
        '--command',
        'gh auth token',
      ]);
      await runProcess('sbx', [
        'policy',
        'allow',
        'network',
        '--sandbox',
        name,
        'github.com,api.github.com',
      ]);
      const checked = await runProcess('sbx', [
        'policy',
        'check',
        'network',
        '--sandbox',
        name,
        'https://api.github.com',
        '--json',
      ]);
      const result: unknown = JSON.parse(checked.stdout);
      if (
        result === null ||
        typeof result !== 'object' ||
        !('allowed' in result) ||
        result.allowed !== true
      ) {
        throw new Error('development Sandbox GitHub publication access was not enabled');
      }
    } catch (error) {
      await this.disablePublication(runId).catch(() => undefined);
      throw error;
    }
  }

  async disablePublication(runId: number): Promise<void> {
    const name = developmentSandboxName(runId);
    await runProcess('sbx', ['secret', 'rm', 'github', '--sandbox', name, '--force']).catch(
      () => undefined,
    );
    await runProcess('sbx', [
      'policy',
      'rm',
      'network',
      '--sandbox',
      name,
      '--resource',
      'github.com,api.github.com',
    ]).catch(() => undefined);
    await this.denyGitHub(name);
  }

  async cleanup(input: {
    runId: number;
    expectedBranch: string;
    expectedHeadSha: string;
    integrated: boolean;
  }): Promise<void> {
    if (!input.integrated) {
      throw new Error('development workspace cleanup requires an observed integrated result');
    }
    const observed = await this.observe(input.runId);
    if (
      observed.branch !== input.expectedBranch ||
      observed.headSha !== input.expectedHeadSha ||
      observed.dirty
    ) {
      throw new Error(
        'development workspace cleanup refused because the integrated Git state is dirty or divergent',
      );
    }
    const name = developmentSandboxName(input.runId);
    await runProcess('sbx', ['stop', name], { timeoutMilliseconds: 2 * 60 * 1000 }).catch(
      () => undefined,
    );
    await runProcess('sbx', ['rm', '--force', name], { timeoutMilliseconds: 2 * 60 * 1000 });
    const runDirectory = this.runDirectory(input.runId);
    rmSync(runDirectory, { recursive: true });
  }

  hasRetainedWorkspace(runId: number): boolean {
    const directory = resolveInside(this.#developmentRoot, String(runId));
    return (
      existsSync(resolveInside(directory, 'workspace')) &&
      existsSync(resolveInside(directory, 'skills'))
    );
  }

  paths(runId: number, create = false): { workspaceDirectory: string; skillsDirectory: string } {
    const runDirectory = this.runDirectory(runId, create);
    const workspaceDirectory = resolveInside(runDirectory, 'workspace');
    const skillsDirectory = resolveInside(runDirectory, 'skills');
    if (create) {
      mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(skillsDirectory, { recursive: true, mode: 0o700 });
    } else if (!existsSync(workspaceDirectory) || !existsSync(skillsDirectory)) {
      throw new Error('development run workspace is unavailable');
    }
    return { workspaceDirectory, skillsDirectory };
  }

  private runDirectory(runId: number, create = false): string {
    developmentSandboxName(runId);
    const directory = resolveInside(this.#developmentRoot, String(runId));
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } else if (!existsSync(directory)) {
      throw new Error(`development run ${runId} has no retained workspace`);
    }
    return realpathSync(directory);
  }

  private snapshotSkill(skillsDirectory: string, name: string, sourceDirectory: string): void {
    const source = realpathSync(sourceDirectory);
    if (!existsSync(join(source, 'SKILL.md')) || basename(source) !== name) {
      throw new Error(`configured ${name} skill directory is invalid`);
    }
    const destination = resolveInside(skillsDirectory, name);
    if (!existsSync(destination)) {
      cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    }
    const snapshot = readFileSync(join(destination, 'SKILL.md'), 'utf8');
    if (snapshot.trim().length === 0) {
      throw new Error(`${name} skill snapshot is empty`);
    }
  }

  private async checkoutBase(input: {
    name: string;
    workspaceDirectory: string;
    branch: string;
    cloneUrl: string;
    baseSha: string;
    readToken: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await runProcess(
      'sbx',
      [
        'exec',
        input.name,
        'sh',
        '-ceu',
        'git -C "$1" init --initial-branch=main && git -C "$1" remote add origin "$2"',
        'sh',
        input.workspaceDirectory,
        input.cloneUrl,
      ],
      input.signal === undefined ? {} : { signal: input.signal },
    );
    await runProcess(
      'sbx',
      [
        'exec',
        '-i',
        input.name,
        'sh',
        '-ceu',
        'IFS= read -r token; authorization=$(printf "x-access-token:%s" "$token" | base64 | tr -d "\\n"); export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $authorization"; git -C "$1" fetch --no-tags origin "+$2:refs/leverframe/base"; git -C "$1" checkout -b "$3" refs/leverframe/base; git -C "$1" config --unset-all http.extraheader 2>/dev/null || true',
        'sh',
        input.workspaceDirectory,
        input.baseSha,
        input.branch,
      ],
      {
        input: `${input.readToken}\n`,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }

  private async denyGitHub(name: string): Promise<void> {
    await runProcess('sbx', [
      'policy',
      'deny',
      'network',
      '--sandbox',
      name,
      'github.com,api.github.com',
    ]);
    const checked = await runProcess('sh', [
      '-ceu',
      'status=0; output=$(sbx policy check network --sandbox "$1" https://api.github.com --json) || status=$?; [ "$status" -eq 1 ]; printf "%s" "$output"',
      'sh',
      name,
    ]);
    const result: unknown = JSON.parse(checked.stdout);
    if (
      result === null ||
      typeof result !== 'object' ||
      !('allowed' in result) ||
      result.allowed !== false
    ) {
      throw new Error('development Sandbox GitHub deny was not enforced');
    }
  }
}

export function assertTaskBranch(branch: string): void {
  if (
    !branch.startsWith(developmentProtocol.branchPrefix) ||
    !/^codex\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/')
  ) {
    throw new Error('development branch must be a safe codex/ task branch');
  }
}

export function parseWorkspaceStatus(value: string): {
  branch: string;
  headSha: string;
  dirty: boolean;
} {
  const lines = value.trimEnd().split('\n');
  const branch = lines.find((line) => line.startsWith('# branch.head '))?.slice(14);
  const headSha = lines.find((line) => line.startsWith('# branch.oid '))?.slice(13);
  if (
    branch === undefined ||
    branch === '(detached)' ||
    headSha === undefined ||
    headSha === '(initial)'
  ) {
    throw new Error('unable to determine development workspace Git identity');
  }
  return {
    branch,
    headSha,
    dirty: lines.some((line) => line !== '' && !line.startsWith('# ')),
  };
}

function resolveInside(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, child);
  const pathFromRoot = relative(resolvedRoot, target);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(target) === resolvedRoot
  ) {
    throw new Error('development path escapes its private root');
  }
  return target;
}

function assertCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('development base SHA must be a full lowercase commit hash');
  }
}

function assertCredentialFreeRemote(value: string): void {
  let remote: URL;
  try {
    remote = new URL(value);
  } catch (error) {
    throw new Error('development clone URL must be an absolute HTTPS URL', { cause: error });
  }
  if (remote.protocol !== 'https:' || remote.username !== '' || remote.password !== '') {
    throw new Error('development clone URL must be credential-free HTTPS');
  }
}
