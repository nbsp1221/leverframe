import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type CAC, cac } from 'cac';
import { loadServerConfig } from './app/config.js';
import { createLeverframeServer } from './app/server.js';
import { DevelopmentController } from './development/controller.js';
import { ExecutionTraceStore } from './execution/trace.js';
import { GitHubAppClient } from './github/client.js';
import { CredentialStore } from './github/credentials.js';
import { ManualCommandHandler } from './jobs/command-handler.js';
import { JobDatabase } from './jobs/database.js';
import { ThreadSideEffectWorker } from './jobs/thread-side-effect-worker.js';
import { ReviewWorker } from './jobs/worker.js';
import { DevelopmentSandboxManager } from './sandbox/development.js';
import { recoverOrphanSandboxes } from './sandbox/recovery.js';
import { SandboxReviewer } from './sandbox/reviewer.js';
import { preflightSandboxRuntime, sandboxRuntimeAvailable } from './sandbox/runtime.js';
import { MulticaCliTicketAdapter } from './tickets/multica-cli.js';
import { TicketProjectionWorker } from './tickets/projection-worker.js';

interface PackageMetadata {
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

export function createCli(startServer: () => void = serve): CAC {
  const cli = cac('leverframe');

  cli.command('serve', 'Start the Leverframe service').action(startServer);
  cli.help();
  cli.version(packageMetadata.version);

  return cli;
}

export function run(args: readonly string[], startServer: () => void = serve): number {
  const cli = createCli(startServer);

  if (args.length === 0) {
    cli.outputHelp();
    return 0;
  }

  cli.parse(['node', 'leverframe', ...args], { run: false });

  if (cli.options.help || cli.options.version) {
    return 0;
  }

  if (!cli.matchedCommand && cli.args[0]) {
    console.error(`Unknown command: ${cli.args[0]}`);
    return 1;
  }

  const command = cli.matchedCommand ?? cli.globalCommand;

  try {
    command.checkUnknownOptions();
    command.checkOptionValue();
    command.checkRequiredArgs();
    command.checkUnusedArgs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  cli.runMatchedCommand();

  return 0;
}

function serve(): void {
  const config = loadServerConfig();
  const credentials = new CredentialStore(config.credentialsDirectory);
  const dataRoot = config.jobsDirectory.replace(/[/\\]jobs$/, '');
  const database = new JobDatabase(config.databasePath, {
    dataRoot,
  });
  const traceStore = new ExecutionTraceStore(config.jobsDirectory);
  const github = new GitHubAppClient(credentials.read());
  const ticketAdapter =
    config.multicaCliPath === null || config.multicaCliPath === undefined
      ? undefined
      : new MulticaCliTicketAdapter({ cliPath: config.multicaCliPath });
  const developmentController = new DevelopmentController({
    allowedOwnerId: config.allowedOwnerId,
    database: database.development,
    github,
    model: config.model,
    resources: database.developmentResources,
    sandbox: new DevelopmentSandboxManager({
      dataDirectory: dataRoot,
      sandboxTemplate: config.sandboxTemplate,
      commitSkillDirectory: config.development.commitSkillDirectory,
      createPrSkillDirectory: config.development.createPrSkillDirectory,
    }),
    verificationCommand: config.development.verificationCommand,
    workerId: `leverframe-${process.pid}`,
  });
  const ticketProjectionWorker =
    ticketAdapter === undefined
      ? undefined
      : new TicketProjectionWorker({
          adapter: ticketAdapter,
          database: database.development,
          projections: database.developmentProjections,
        });
  const worker = new ReviewWorker({
    allowedOwnerId: config.allowedOwnerId,
    credentials,
    database,
    jobsDirectory: config.jobsDirectory,
    onReviewCompleted: ({ accepted, findings, job }) => {
      void developmentController.observeReviewCompleted({
        accepted,
        findings: findings.map((finding) => ({
          evidence: finding.evidence,
          file: finding.file,
          fingerprint: finding.fingerprint,
          line: finding.line,
          title: finding.title,
        })),
        headSha: job.headSha,
        jobId: job.id,
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
      });
    },
    reviewer: new SandboxReviewer({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      resourcesDirectory: config.resourcesDirectory,
      sandboxTemplate: config.sandboxTemplate,
      traceStore,
    }),
  });
  const threadWorker = new ThreadSideEffectWorker({ credentials, database });
  const commandHandler = new ManualCommandHandler({ credentials, database, worker });
  const server = createLeverframeServer(
    config,
    database,
    credentials,
    {
      isSandboxAvailable: () => sandboxRuntimeAvailable(config.sandboxTemplate),
      isWorkerRunning: () => worker.isRunning && threadWorker.isRunning,
      onJobQueued: (job) => worker.cancelSuperseded(job),
      onManualCommand: (command) => commandHandler.handle(command),
      onPullRequestCancelled: (cancellation) => {
        worker.cancelPullRequest(cancellation);
        if (cancellation.merged === true) {
          developmentController.observePullRequestMerged(cancellation);
        }
      },
      getFindingContext: (input) => github.getFindingContext(input),
      listDevelopmentRepositories: async () =>
        (await github.listRepositories(config.allowedOwnerId)).map((repository) => ({
          default_branch: repository.defaultBranch,
          private: repository.private,
          repository: repository.repository,
        })),
      resolveDevelopmentRepository: async (repository) => {
        const resolved = await github.resolveRepository({
          allowedOwnerId: config.allowedOwnerId,
          repository,
        });
        if (resolved === undefined) {
          return undefined;
        }
        return {
          baseSha: resolved.defaultBranchSha,
          cloneUrl: resolved.cloneUrl,
          defaultBranch: resolved.defaultBranch,
          installationId: resolved.installationId,
          repositoryId: resolved.repositoryId,
        };
      },
      ...(ticketAdapter === undefined
        ? {}
        : {
            listDevelopmentTickets: async () =>
              (await ticketAdapter.listTickets({ limit: 100, offset: 0 })).map((ticket) => ({
                id: ticket.id,
                key: ticket.key,
                priority: ticket.priority,
                project_id: ticket.projectId,
                status: ticket.status,
                title: ticket.title,
              })),
            importDevelopmentTicket: async (id: string) => {
              const [ticket, repositories] = await Promise.all([
                ticketAdapter.getTicket(id),
                github.listRepositories(config.allowedOwnerId),
              ]);
              const accessible = new Set(repositories.map((repository) => repository.repository));
              return {
                id: ticket.id,
                key: ticket.key,
                priority: ticket.priority,
                project_id: ticket.projectId,
                status: ticket.status,
                title: ticket.title,
                goal: [ticket.title, ticket.description].filter(Boolean).join('\n\n'),
                repository_suggestions: ticket.repositorySuggestions.map((repository) => ({
                  accessible: accessible.has(repository),
                  repository,
                })),
                external_source: {
                  provider: 'multica' as const,
                  id: ticket.id,
                  key: ticket.key,
                  url: ticket.url,
                },
              };
            },
          }),
      onDevelopmentRunCreated: (runId: number) => {
        void developmentController.startPlanning(runId);
      },
      onDevelopmentRunCancelled: (runId: number) => developmentController.cancelRun(runId),
      onDevelopmentRunCleanup: (runId: number) => developmentController.cleanupRun(runId),
      onDevelopmentClarificationAnswer: (
        input: Parameters<DevelopmentController['answerClarification']>[0],
      ) => {
        developmentController.answerClarification(input);
      },
      onDevelopmentPlanApproval: (input: Parameters<DevelopmentController['approvePlan']>[0]) => {
        void developmentController.approvePlan(input);
      },
      onDevelopmentPublicationApproval: (
        input: Parameters<DevelopmentController['approvePublication']>[0],
      ) => {
        void developmentController.approvePublication(input);
      },
    },
    traceStore,
  );

  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Stop accepting new requests first. SSE streams can remain open for an
    // entire run, so close active connections after workers have stopped.
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    void (async () => {
      try {
        await Promise.all([
          worker.stop(),
          threadWorker.stop(),
          developmentController.stop(),
          ticketProjectionWorker?.stop(),
        ]);
        server.closeAllConnections();
        await serverClosed;
        database.close();
        process.exitCode = 0;
      } catch (error) {
        console.error('graceful shutdown failed', error);
        database.close();
        process.exitCode = 1;
      }
    })();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(config.port, config.host, () => {
    console.log(`Leverframe listening on http://${config.host}:${config.port}`);
    void (async () => {
      await developmentController.recover();
      ticketProjectionWorker?.start();
      await startWorkersAfterRecovery(
        config.sandboxTemplate,
        config.jobsDirectory,
        database,
        worker,
        threadWorker,
      );
    })().catch((error: unknown) => {
      console.error('startup recovery failed; workers were not started', error);
    });
  });
}

async function startWorkersAfterRecovery(
  sandboxTemplate: string,
  jobsDirectory: string,
  database: JobDatabase,
  worker: ReviewWorker,
  threadWorker: ThreadSideEffectWorker,
): Promise<void> {
  try {
    const removed = await recoverOrphanSandboxes(database.getActiveJobIds());
    if (removed.length > 0) {
      console.log(`removed ${removed.length} orphan review sandbox(es): ${removed.join(', ')}`);
    }
  } catch (error) {
    console.warn('orphan review sandbox recovery failed; continuing startup', error);
  }
  threadWorker.start();
  try {
    const evidence = await preflightSandboxRuntime(sandboxTemplate, jobsDirectory);
    console.log(`sandbox preflight passed\n${evidence}`);
    worker.start();
  } catch (error) {
    console.error('sandbox preflight failed; review worker was not started', error);
  }
}

const entrypoint = process.argv[1];

if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = run(process.argv.slice(2));
}
