import { describe, expect, it, vi } from 'vitest';
import type { AppServerNotification, CodexAppServer } from '../../../src/codex/app-server.js';
import type { GitHubAppClient } from '../../../src/github/client.js';
import type { DevelopmentSandboxManager } from '../../../src/sandbox/development.js';
import { DevelopmentController } from '../../../src/development/controller.js';
import { openDatabase } from '../../../src/storage/connection.js';
import { DevelopmentRepository } from '../../../src/storage/development-repository.js';
import { runMigrations } from '../../../src/storage/migrations/index.js';

function setup(input: { prepareFailure?: Error } = {}) {
  const database = openDatabase(':memory:');
  runMigrations(database);
  const repository = new DevelopmentRepository(database);
  const run = repository.createRun({
    goal: 'Plan the smallest useful feature.',
    repository: 'example/leverframe',
  });
  const findOpenPullRequest = vi.fn().mockResolvedValue({
    number: 12,
    state: 'open',
    url: 'https://github.com/example/leverframe/pull/12',
    headSha: 'b'.repeat(40),
  });
  const github = {
    getRepository: vi.fn().mockResolvedValue({
      cloneUrl: 'https://github.com/example/leverframe.git',
      defaultBranch: 'main',
      defaultBranchSha: 'a'.repeat(40),
      installationId: 1,
      repositoryId: 2,
    }),
    createRepositoryReadToken: vi.fn().mockResolvedValue('read-token'),
    findOpenPullRequest,
  } as unknown as GitHubAppClient;
  const stop = vi.fn().mockResolvedValue(undefined);
  const enablePublication = vi.fn().mockResolvedValue(undefined);
  const disablePublication = vi.fn().mockResolvedValue(undefined);
  const candidateHash = 'c'.repeat(64);
  const sandbox = {
    prepare:
      input.prepareFailure === undefined
        ? vi.fn().mockResolvedValue({
            name: 'leverframe-dev-1',
            branch: 'codex/development-1',
            workspaceDirectory: '/private/workspace',
            skillsDirectory: '/private/skills',
          })
        : vi.fn().mockRejectedValue(input.prepareFailure),
    stop,
    paths: vi.fn().mockReturnValue({
      workspaceDirectory: '/private/workspace',
      skillsDirectory: '/private/skills',
    }),
    candidateIdentity: vi.fn().mockResolvedValue({
      hash: candidateHash,
      headSha: 'b'.repeat(40),
      dirty: false,
    }),
    runVerification: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    enablePublication,
    disablePublication,
  } as unknown as DevelopmentSandboxManager;
  let onNotification: ((notification: AppServerNotification) => void) | undefined;
  const close = vi.fn();
  const startTurn = vi.fn().mockImplementation(() => {
    queueMicrotask(() => {
      onNotification?.({
        method: 'item/completed',
        params: { item: { id: 'message-1', type: 'agentMessage', text: 'A bounded plan.' } },
      });
      onNotification?.({ method: 'turn/completed', params: {} });
    });
    return Promise.resolve('01990ef4-4c57-7000-8000-000000000002');
  });
  const appServer = {
    setSkillRoots: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([
      { enabled: true, name: 'commit', path: '/private/skills/commit/SKILL.md' },
      { enabled: true, name: 'create-pr', path: '/private/skills/create-pr/SKILL.md' },
    ]),
    startThread: vi.fn().mockResolvedValue('01990ef4-4c57-7000-8000-000000000001'),
    resumeThread: vi.fn().mockResolvedValue(undefined),
    startTurn,
    close,
  } as unknown as CodexAppServer;
  const launchAppServer: NonNullable<
    ConstructorParameters<typeof DevelopmentController>[0]['launchAppServer']
  > = vi.fn().mockImplementation((options: Parameters<typeof CodexAppServer.launch>[0]) => {
    onNotification = options.onNotification;
    return Promise.resolve(appServer);
  });
  const controller = new DevelopmentController({
    allowedOwnerId: 1,
    database: repository,
    github,
    launchAppServer,
    model: 'gpt-5.6-sol',
    sandbox,
    verificationCommand: 'pnpm check',
    workerId: 'test-worker',
  });
  return {
    close,
    controller,
    database,
    disablePublication,
    enablePublication,
    findOpenPullRequest,
    repository,
    run,
    sandbox,
    stop,
  };
}

describe('DevelopmentController planning', () => {
  it('owns preparation and a Codex planning turn before requiring plan approval', async () => {
    const context = setup();
    await context.controller.startPlanning(context.run.id);

    expect(context.repository.requireRun(context.run.id)).toMatchObject({
      phase: 'AWAITING_PLAN_APPROVAL',
      generation: 3,
    });
    expect(context.repository.findActiveAttempt(context.run.id)).toBeUndefined();
    expect(context.repository.getOpenInterrupt(context.run.id)).toMatchObject({
      kind: 'PLAN_APPROVAL',
      lockVersion: 1,
    });
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.stop).toHaveBeenCalledWith(context.run.id);
    expect(context.controller.activeRuns).toEqual([]);
    context.database.close();
  });

  it('fences a failed preparation attempt and leaves the retained run explainable', async () => {
    const context = setup({ prepareFailure: new Error('sandbox unavailable') });
    await context.controller.startPlanning(context.run.id);

    expect(context.repository.requireRun(context.run.id).phase).toBe('FAILED');
    expect(context.repository.findActiveAttempt(context.run.id)).toBeUndefined();
    expect(context.stop).toHaveBeenCalledWith(context.run.id);
    context.database.close();
  });

  it('resumes the same thread after plan approval and requires exact-candidate publication approval', async () => {
    const context = setup();
    await context.controller.startPlanning(context.run.id);
    const approval = context.repository.getOpenInterrupt(context.run.id);
    if (approval === undefined) {
      throw new Error('plan approval was not created');
    }

    await context.controller.approvePlan({
      runId: context.run.id,
      interruptId: approval.id,
      interruptLockVersion: approval.lockVersion,
      approve: true,
    });

    const run = context.repository.requireRun(context.run.id);
    expect(run).toMatchObject({
      candidateHash: 'c'.repeat(64),
      phase: 'AWAITING_PUBLICATION_APPROVAL',
    });
    expect(context.repository.getOpenInterrupt(run.id)).toMatchObject({
      candidateHash: 'c'.repeat(64),
      kind: 'PUBLICATION_APPROVAL',
      publicationKind: 'PUSH_AND_PR',
    });
    expect(context.repository.findActiveAttempt(run.id)).toBeUndefined();
    context.database.close();
  });

  it('publishes only the approved candidate and observes the pull request before review', async () => {
    const context = setup();
    await context.controller.startPlanning(context.run.id);
    const plan = context.repository.getOpenInterrupt(context.run.id);
    if (plan === undefined) {
      throw new Error('plan approval was not created');
    }
    await context.controller.approvePlan({
      runId: context.run.id,
      interruptId: plan.id,
      interruptLockVersion: plan.lockVersion,
      approve: true,
    });
    const publication = context.repository.getOpenInterrupt(context.run.id);
    if (publication?.candidateHash === undefined) {
      throw new Error('publication approval was not created');
    }

    await context.controller.approvePublication({
      runId: context.run.id,
      interruptId: publication.id,
      interruptLockVersion: publication.lockVersion,
      candidateHash: publication.candidateHash,
      approve: true,
    });

    expect(context.repository.requireRun(context.run.id).phase).toBe('REVIEWING');
    expect(context.enablePublication).toHaveBeenCalledWith(context.run.id);
    expect(context.disablePublication).toHaveBeenCalledWith(context.run.id);
    expect(context.findOpenPullRequest).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'example/leverframe',
      branch: 'codex/development-1',
    });
    expect(
      context.repository
        .listEvents(context.run.id)
        .some((event) => event.type === 'pull_request_observed'),
    ).toBe(true);
    context.database.close();
  });
});
