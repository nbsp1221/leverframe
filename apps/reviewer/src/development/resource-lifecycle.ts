import type { DevelopmentSandboxManager } from '../sandbox/development.js';
import type { DevelopmentRepository } from '../storage/development-repository.js';
import type { DevelopmentResourceRepository } from '../storage/development-resource-repository.js';
import { developmentSandboxName } from '../identity.js';

export class DevelopmentResourceLifecycle {
  constructor(
    private readonly options: {
      database: DevelopmentRepository;
      resources: DevelopmentResourceRepository;
      sandbox: DevelopmentSandboxManager;
    },
  ) {}

  reconcileRetained(): void {
    for (const run of this.options.database.listRuns()) {
      if (
        this.options.resources.list(run.id).length > 0 ||
        !this.options.sandbox.hasRetainedWorkspace(run.id)
      ) {
        continue;
      }
      for (const resource of resourceIdentities(run.id)) {
        this.options.resources.observe({
          runId: run.id,
          generation: run.generation,
          state: resource.kind === 'SANDBOX' ? 'UNKNOWN' : 'RETAINED',
          ...resource,
        });
      }
    }
  }

  observePreparing(runId: number, generation: number): void {
    for (const resource of resourceIdentities(runId)) {
      this.options.resources.observe({
        runId,
        generation,
        state: 'PROVISIONING',
        ...resource,
      });
    }
  }

  observeActive(runId: number, generation: number): void {
    for (const resource of resourceIdentities(runId)) {
      this.options.resources.observe({ runId, generation, state: 'ACTIVE', ...resource });
    }
  }

  async stopAndRetain(runId: number): Promise<void> {
    await this.options.sandbox.stop(runId).catch(() => undefined);
    const run = this.options.database.getRun(runId);
    if (run === undefined) {
      return;
    }
    for (const resource of this.options.resources.list(runId)) {
      this.options.resources.observe({
        runId,
        kind: resource.kind,
        provider: resource.provider,
        externalId: resource.externalId,
        state: resource.kind === 'SANDBOX' ? 'STOPPED' : 'RETAINED',
        generation: run.generation,
      });
    }
  }

  async cleanup(runId: number): Promise<void> {
    const run = this.options.database.requireRun(runId);
    if (run.phase !== 'COMPLETED') {
      throw new Error(`development run ${runId} cleanup requires an observed merge`);
    }
    const resources = this.options.resources.list(runId);
    if (resources.every((resource) => resource.state === 'CLEANED')) {
      return;
    }
    this.observeCleanupState(runId, run.generation, 'CLEANUP_PENDING');
    try {
      await this.options.sandbox.cleanup({
        runId,
        expectedBranch: branchName(runId),
        integrated: true,
      });
      this.observeCleanupState(runId, run.generation, 'CLEANED');
      this.options.database.appendEvent(runId, run.generation, {
        type: 'resources_cleaned',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
      });
    } catch (error) {
      this.observeCleanupState(
        runId,
        run.generation,
        'CLEANUP_FAILED',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private observeCleanupState(
    runId: number,
    generation: number,
    state: 'CLEANUP_PENDING' | 'CLEANUP_FAILED' | 'CLEANED',
    error?: string,
  ): void {
    for (const resource of this.options.resources.list(runId)) {
      this.options.resources.observe({
        runId,
        kind: resource.kind,
        provider: resource.provider,
        externalId: resource.externalId,
        state,
        generation,
        ...(error === undefined ? {} : { error }),
      });
    }
  }
}

function resourceIdentities(runId: number) {
  return [
    {
      kind: 'SANDBOX' as const,
      provider: 'docker-sandboxes',
      externalId: developmentSandboxName(runId),
    },
    {
      kind: 'WORKSPACE' as const,
      provider: 'leverframe',
      externalId: `development-workspace-${runId}`,
    },
    { kind: 'BRANCH' as const, provider: 'git', externalId: branchName(runId) },
  ];
}

function branchName(runId: number): string {
  return `codex/development-${runId}`;
}
