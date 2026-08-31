import { describe, expect, it, vi } from 'vitest';
import type {
  AppServerNotification,
  AppServerRequest,
  CodexAppServer,
} from '../../../src/codex/app-server.js';
import type { GitHubAppClient } from '../../../src/github/client.js';
import type { DevelopmentSandboxManager } from '../../../src/sandbox/development.js';
import { DevelopmentController } from '../../../src/development/controller.js';
import { openDatabase } from '../../../src/storage/connection.js';
import { DevelopmentRepository } from '../../../src/storage/development-repository.js';
import { DevelopmentResourceRepository } from '../../../src/storage/development-resource-repository.js';
import { runMigrations } from '../../../src/storage/migrations/index.js';

function setup(
  input: {
    clarifyDuringPlanning?: boolean;
    disablePublicationFailure?: Error;
    prepareFailure?: Error;
    stopFailure?: Error;
    verificationFailures?: Error[];
  } = {},
) {
  const database = openDatabase(':memory:');
  runMigrations(database);
  const repository = new DevelopmentRepository(database);
  const run = repository.createRun({
    goal: 'Plan the smallest useful feature.',
    repository: 'example/leverframe',
    checkout: {
      baseSha: 'a'.repeat(40),
      cloneUrl: 'https://github.com/example/leverframe.git',
      defaultBranch: 'main',
      installationId: 1,
      repositoryId: 2,
    },
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
  const stop =
    input.stopFailure === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(input.stopFailure);
  const enablePublication = vi.fn().mockResolvedValue(undefined);
  const disablePublication =
    input.disablePublicationFailure === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(input.disablePublicationFailure);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const hasRetainedWorkspace = vi.fn().mockReturnValue(true);
  const candidateHash = 'c'.repeat(64);
  const verificationFailures = [...(input.verificationFailures ?? [])];
  const runVerification = vi.fn().mockImplementation(() => {
    const failure = verificationFailures.shift();
    return failure === undefined
      ? Promise.resolve({ stdout: '', stderr: '' })
      : Promise.reject(failure);
  });
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
    runVerification,
    enablePublication,
    disablePublication,
    cleanup,
    hasRetainedWorkspace,
  } as unknown as DevelopmentSandboxManager;
  let onNotification: ((notification: AppServerNotification) => void) | undefined;
  let onRequest: ((request: AppServerRequest) => Promise<unknown>) | undefined;
  let clarificationResponse: unknown;
  const turnPrompts: string[] = [];
  const turnSkills: Array<unknown[] | undefined> = [];
  const close = vi.fn();
  const startTurn = vi
    .fn()
    .mockImplementation((turnInput: { prompt: string; skills?: unknown[] }) => {
      turnPrompts.push(turnInput.prompt);
      turnSkills.push(turnInput.skills);
      const turnId = '01990ef4-4c57-7000-8000-000000000002';
      setTimeout(() => {
        void (async () => {
          if (input.clarifyDuringPlanning === true && startTurn.mock.calls.length === 1) {
            clarificationResponse = await onRequest?.({
              id: 'clarification-1',
              method: 'item/tool/requestUserInput',
              params: {
                threadId: '01990ef4-4c57-7000-8000-000000000001',
                turnId,
                itemId: 'item-1',
                isBlocking: true,
                questions: [
                  {
                    id: 'scope',
                    header: 'Scope',
                    question: 'Which surface should change?',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: 'Web', description: 'Change the dashboard.' }],
                  },
                ],
              },
            });
          }
          onNotification?.({
            method: 'item/completed',
            params: { item: { id: 'message-1', type: 'agentMessage', text: 'A bounded plan.' } },
          });
          onNotification?.({ method: 'turn/completed', params: {} });
        })();
      }, 0);
      return Promise.resolve(turnId);
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
    onRequest = options.onRequest;
    return Promise.resolve(appServer);
  });
  const controller = new DevelopmentController({
    allowedOwnerId: 1,
    database: repository,
    github,
    launchAppServer,
    model: 'gpt-5.6-sol',
    resources: new DevelopmentResourceRepository(database),
    sandbox,
    verificationCommand: 'pnpm check',
    workerId: 'test-worker',
  });
  return {
    close,
    cleanup,
    getClarificationResponse: () => clarificationResponse,
    controller,
    database,
    disablePublication,
    enablePublication,
    findOpenPullRequest,
    getLastTurnPrompt: () => turnPrompts.at(-1),
    getLastTurnSkills: () => turnSkills.at(-1),
    repository,
    runVerification,
    run,
    sandbox,
    startTurn,
    stop,
  };
}

async function publishCandidate(context: ReturnType<typeof setup>): Promise<void> {
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
}

describe('development restart recovery', () => {
  it('reconstructs retained resource state without exposing host paths', async () => {
    const context = setup();

    await context.controller.recover();

    expect(context.controller.options.resources.list(context.run.id)).toEqual([
      expect.objectContaining({
        kind: 'SANDBOX',
        externalId: 'leverframe-dev-1',
        state: 'UNKNOWN',
      }),
      expect.objectContaining({
        kind: 'WORKSPACE',
        externalId: 'development-workspace-1',
        state: 'RETAINED',
      }),
      expect.objectContaining({
        kind: 'BRANCH',
        externalId: 'codex/development-1',
        state: 'RETAINED',
      }),
    ]);
  });

  it('fences an execution interrupted by process restart', async () => {
    const context = setup();
    const preparing = context.repository.transition({
      id: context.run.id,
      expectedGeneration: context.run.generation,
      expectedLockVersion: context.run.lockVersion,
      phase: 'PREPARING',
      advanceGeneration: true,
      event: {
        type: 'workspace_preparing',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
      },
    });
    context.repository.claimAttempt({
      runId: preparing.id,
      expectedGeneration: preparing.generation,
      expectedLockVersion: preparing.lockVersion,
      phase: 'PREPARING',
      executorKind: 'DETERMINISTIC',
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await context.controller.recover();

    expect(context.repository.requireRun(context.run.id).phase).toBe('FAILED');
    expect(context.repository.findActiveAttempt(context.run.id)).toBeUndefined();
    expect(context.stop).toHaveBeenCalledWith(context.run.id);
  });
});

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
    expect(context.controller.options.resources.list(context.run.id)).toMatchObject([
      { kind: 'SANDBOX', state: 'STOPPED' },
      { kind: 'WORKSPACE', state: 'RETAINED' },
      { kind: 'BRANCH', state: 'RETAINED' },
    ]);
    expect(context.controller.activeRuns).toEqual([]);
    context.database.close();
  });

  it('persists and answers a material clarification inside the active planning turn', async () => {
    const context = setup({ clarifyDuringPlanning: true });
    const completion = context.controller.startPlanning(context.run.id);
    await vi.waitFor(() => {
      expect(context.repository.requireRun(context.run.id).phase).toBe('WAITING_FOR_INPUT');
    });
    const clarification = context.repository.getOpenInterrupt(context.run.id);
    expect(clarification).toMatchObject({
      kind: 'CLARIFICATION',
      questions: [{ id: 'scope', question: 'Which surface should change?' }],
    });
    if (clarification === undefined) {
      throw new Error('clarification was not created');
    }

    expect(() =>
      context.controller.answerClarification({
        runId: context.run.id,
        interruptId: clarification.id,
        interruptLockVersion: clarification.lockVersion,
        answers: { different: ['Web'] },
      }),
    ).toThrow('do not match');
    expect(context.repository.requireRun(context.run.id).phase).toBe('WAITING_FOR_INPUT');

    context.controller.answerClarification({
      runId: context.run.id,
      interruptId: clarification.id,
      interruptLockVersion: clarification.lockVersion,
      answers: { scope: ['Web'] },
    });
    await completion;

    expect(context.getClarificationResponse()).toEqual({
      answers: { scope: { answers: ['Web'] } },
    });
    expect(context.repository.requireRun(context.run.id).phase).toBe('AWAITING_PLAN_APPROVAL');
    expect(
      context.repository
        .listEvents(context.run.id)
        .map((event) => event.type)
        .filter((type) => type.startsWith('clarification_')),
    ).toEqual(['clarification_required', 'clarification_answered']);
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

  it('cancels a waiting run and retains its resources', async () => {
    const context = setup();
    await context.controller.startPlanning(context.run.id);

    await context.controller.cancelRun(context.run.id);

    expect(context.repository.requireRun(context.run.id).phase).toBe('CANCELLED');
    expect(context.repository.getOpenInterrupt(context.run.id)).toBeUndefined();
    expect(context.controller.options.resources.list(context.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'SANDBOX', state: 'STOPPED' }),
        expect.objectContaining({ kind: 'WORKSPACE', state: 'RETAINED' }),
      ]),
    );
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
      response: 'Keep the existing API contract unchanged.',
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
    expect(context.getLastTurnPrompt()).toContain('Keep the existing API contract unchanged.');
    context.database.close();
  });

  it('revises a rejected plan on the same thread and requests approval again', async () => {
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
      approve: false,
      response: 'Reduce the scope to the repository picker.',
    });

    expect(context.repository.requireRun(context.run.id).phase).toBe('AWAITING_PLAN_APPROVAL');
    expect(context.repository.getOpenInterrupt(context.run.id)).toMatchObject({
      kind: 'PLAN_APPROVAL',
      prompt: 'Approve this revised implementation plan?',
    });
    expect(context.startTurn).toHaveBeenCalledTimes(2);
    expect(context.getLastTurnPrompt()).toContain('Reduce the scope to the repository picker.');
    context.database.close();
  });

  it('revises a rejected publication candidate and verifies the replacement automatically', async () => {
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
      approve: false,
      response: 'Remove the unrelated copy change before publishing.',
    });

    expect(context.repository.requireRun(context.run.id).phase).toBe(
      'AWAITING_PUBLICATION_APPROVAL',
    );
    expect(context.getLastTurnPrompt()).toContain(
      'Remove the unrelated copy change before publishing.',
    );
    expect(context.runVerification).toHaveBeenCalledTimes(2);
    context.database.close();
  });

  it('returns deterministic verification failures to implementation until they pass', async () => {
    const context = setup({ verificationFailures: [new Error('typecheck failed in src/a.ts')] });
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

    expect(context.repository.requireRun(context.run.id).phase).toBe(
      'AWAITING_PUBLICATION_APPROVAL',
    );
    expect(context.runVerification).toHaveBeenCalledTimes(2);
    expect(context.startTurn).toHaveBeenCalledTimes(3);
    expect(context.getLastTurnPrompt()).toContain('typecheck failed in src/a.ts');
    expect(context.repository.listEvidence(context.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verdict: 'FAILED' }),
        expect.objectContaining({ verdict: 'PASSED' }),
      ]),
    );
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

  it('fails closed and quarantines the sandbox when publication capability revocation fails', async () => {
    const context = setup({
      disablePublicationFailure: new Error('network policy restore failed'),
    });

    await publishCandidate(context);

    expect(context.repository.requireRun(context.run.id).phase).toBe('FAILED');
    const resources = context.controller.options.resources.list(context.run.id);
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'SANDBOX',
          state: 'CLEANUP_FAILED',
        }),
        expect.objectContaining({ kind: 'WORKSPACE', state: 'RETAINED' }),
        expect.objectContaining({ kind: 'BRANCH', state: 'RETAINED' }),
      ]),
    );
    expect(resources.find((resource) => resource.kind === 'SANDBOX')?.lastError).toContain(
      'network policy restore failed',
    );
    context.database.close();
  });

  it('records an unknown sandbox state instead of claiming a failed stop succeeded', async () => {
    const context = setup({ stopFailure: new Error('sandbox stop failed') });

    await context.controller.startPlanning(context.run.id);

    expect(context.repository.requireRun(context.run.id).phase).toBe('FAILED');
    expect(context.controller.options.resources.list(context.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'SANDBOX',
          state: 'UNKNOWN',
          lastError: 'sandbox stop failed',
        }),
        expect.objectContaining({ kind: 'WORKSPACE', state: 'RETAINED' }),
      ]),
    );
    context.database.close();
  });

  it('returns actionable review findings to the same thread and requires one existing-PR push approval', async () => {
    const context = setup();
    await publishCandidate(context);

    await context.controller.observeReviewCompleted({
      accepted: false,
      findings: [
        {
          evidence: 'The stale branch is still reachable.',
          file: 'src/example.ts',
          fingerprint: '1234567890abcdef',
          line: 12,
          title: 'Remove stale branch',
        },
      ],
      headSha: 'b'.repeat(40),
      jobId: 9,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });

    expect(context.repository.requireRun(context.run.id).phase).toBe(
      'AWAITING_PUBLICATION_APPROVAL',
    );
    expect(context.repository.getOpenInterrupt(context.run.id)).toMatchObject({
      kind: 'PUBLICATION_APPROVAL',
      publicationKind: 'PUSH_EXISTING',
    });
    expect(context.getLastTurnPrompt()).toContain('rather than trusting it blindly');
    expect(context.getLastTurnPrompt()).toContain('1234567890abcdef');

    const publication = context.repository.getOpenInterrupt(context.run.id);
    if (publication?.candidateHash === undefined) {
      throw new Error('existing pull request publication approval was not created');
    }
    await context.controller.approvePublication({
      runId: context.run.id,
      interruptId: publication.id,
      interruptLockVersion: publication.lockVersion,
      candidateHash: publication.candidateHash,
      approve: true,
    });
    expect(context.getLastTurnPrompt()).toContain('approved one update of existing pull request');
    expect(context.getLastTurnSkills()).toBeUndefined();
    context.database.close();
  });

  it('waits for and observes a merge only after the current review has no actionable findings', async () => {
    const context = setup();
    await publishCandidate(context);

    await context.controller.observeReviewCompleted({
      accepted: false,
      findings: [],
      headSha: 'b'.repeat(40),
      jobId: 9,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(context.repository.requireRun(context.run.id).phase).toBe('REVIEWING');

    await context.controller.observeReviewCompleted({
      accepted: true,
      findings: [],
      headSha: 'b'.repeat(40),
      jobId: 10,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(context.repository.requireRun(context.run.id).phase).toBe('AWAITING_MERGE');

    await context.controller.observePullRequestClosed({
      action: 'closed',
      deliveryId: 'stale-merge',
      headSha: 'd'.repeat(40),
      installationId: 1,
      merged: true,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(context.repository.requireRun(context.run.id).phase).toBe('AWAITING_MERGE');

    await context.controller.observePullRequestClosed({
      action: 'closed',
      deliveryId: 'current-merge',
      headSha: 'b'.repeat(40),
      installationId: 1,
      merged: true,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(context.repository.requireRun(context.run.id).phase).toBe('COMPLETED');
    await context.controller.cleanupRun(context.run.id);
    expect(context.cleanup).toHaveBeenCalledWith({
      runId: context.run.id,
      expectedBranch: `codex/development-${context.run.id}`,
      integrated: true,
    });
    expect(context.controller.options.resources.list(context.run.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'CLEANED' })]),
    );
    context.database.close();
  });

  it('completes an exact merged candidate directly from review', async () => {
    const context = setup();
    await publishCandidate(context);

    await context.controller.observePullRequestClosed({
      action: 'closed',
      deliveryId: 'early-merge',
      headSha: 'b'.repeat(40),
      installationId: 1,
      merged: true,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });

    expect(context.repository.requireRun(context.run.id).phase).toBe('COMPLETED');
    context.database.close();
  });

  it('cancels a closed unmerged pull request but keeps draft review work waiting', async () => {
    const draft = setup();
    await publishCandidate(draft);
    await draft.controller.observePullRequestClosed({
      action: 'converted_to_draft',
      deliveryId: 'draft',
      headSha: 'b'.repeat(40),
      installationId: 1,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(draft.repository.requireRun(draft.run.id).phase).toBe('REVIEWING');
    draft.database.close();

    const closed = setup();
    await publishCandidate(closed);
    await closed.controller.observePullRequestClosed({
      action: 'closed',
      deliveryId: 'closed',
      headSha: 'b'.repeat(40),
      installationId: 1,
      merged: false,
      pullRequestNumber: 12,
      repository: 'example/leverframe',
    });
    expect(closed.repository.requireRun(closed.run.id).phase).toBe('CANCELLED');
    expect(closed.controller.options.resources.list(closed.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'SANDBOX', state: 'STOPPED' }),
        expect.objectContaining({ kind: 'WORKSPACE', state: 'RETAINED' }),
      ]),
    );
    closed.database.close();
  });

  it.each([
    { merged: false, phase: 'CANCELLED' as const },
    { merged: true, phase: 'COMPLETED' as const },
  ])(
    'handles exact PR closure while a review fix awaits republication',
    async ({ merged, phase }) => {
      const context = setup();
      await publishCandidate(context);
      await context.controller.observeReviewCompleted({
        accepted: false,
        findings: [
          {
            evidence: 'The published candidate needs a bounded fix.',
            file: 'src/example.ts',
            fingerprint: 'fedcba0987654321',
            line: 8,
            title: 'Fix the published candidate',
          },
        ],
        headSha: 'b'.repeat(40),
        jobId: 11,
        pullRequestNumber: 12,
        repository: 'example/leverframe',
      });
      expect(context.repository.requireRun(context.run.id).phase).toBe(
        'AWAITING_PUBLICATION_APPROVAL',
      );

      await context.controller.observePullRequestClosed({
        action: 'closed',
        deliveryId: merged ? 'merged-during-republish' : 'closed-during-republish',
        headSha: 'b'.repeat(40),
        installationId: 1,
        merged,
        pullRequestNumber: 12,
        repository: 'example/leverframe',
      });

      expect(context.repository.requireRun(context.run.id).phase).toBe(phase);
      expect(context.stop).toHaveBeenCalledWith(context.run.id);
      context.database.close();
    },
  );
});
