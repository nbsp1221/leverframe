import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeverframeServer } from '../../src/app/server.js';
import { CredentialStore } from '../../src/github/credentials.js';
import { JobDatabase } from '../../src/jobs/database.js';

const root = mkdtempSync(join(tmpdir(), 'leverframe-e2e-'));
const dataRoot = join(root, 'data');
const credentialsDirectory = join(dataRoot, 'credentials');
const credentials = new CredentialStore(credentialsDirectory);
credentials.write({
  appId: 1,
  clientId: 'e2e-client',
  name: 'e2e',
  privateKey: 'e2e-private-key',
  slug: 'e2e',
  webhookSecret: 'e2e-webhook-secret',
});
const databasePath = join(dataRoot, 'state.sqlite');
const database = new JobDatabase(databasePath, { dataRoot });
const result = {
  coverage: {
    changed_files: ['src/e2e.ts'],
    complete: true,
    omitted_files: [],
    reviewed_files: ['src/e2e.ts'],
  },
  finding_updates: [],
  findings: [
    {
      confidence: 'high' as const,
      evidence: 'Stored E2E evidence',
      explanation: 'E2E finding for the real reviewer contract.',
      file: 'src/e2e.ts',
      line: 12,
      severity: 'medium' as const,
      suggested_action: 'Add a regression test.',
      title: 'E2E finding',
    },
  ],
  limitations: [],
  summary: 'Real E2E review artifact',
  tests_run: [],
};

database.enqueuePullRequest({
  action: 'opened',
  deliveryId: 'e2e-1',
  headSha: '1'.padStart(40, '0'),
  baseSha: 'a'.repeat(40),
  installationId: 42,
  policyVersion: 'e2e-v1',
  pullRequestNumber: 1,
  pullRequestTitle: 'Real E2E review',
  repository: 'e2e/example',
});
const job = database.claimNextJob();
if (job === undefined) {
  throw new Error('unable to claim E2E seed job');
}
database.updateJob({ id: job.id, state: 'DONE', expectedStates: ['CHECKING_OUT'] });
database.recordReviewArtifact(job.id, result);

const server = createLeverframeServer(
  {
    allowedOwnerId: 1,
    credentialsDirectory,
    databasePath,
    host: '127.0.0.1',
    jobsDirectory: join(dataRoot, 'jobs'),
    githubAppName: 'e2e',
    model: 'e2e-model',
    port: 16722,
    uiBaseUrl: 'http://127.0.0.1:16722',
    webhookUrl: 'http://127.0.0.1:16722/webhooks/github',
    reasoningEffort: 'low',
    resourcesDirectory: fileURLToPath(new URL('../../resources', import.meta.url)),
  },
  database,
  credentials,
);

server.listen(16722, '127.0.0.1', () => {
  console.log('E2E_REVIEWER_READY http://127.0.0.1:16722');
});

function shutdown() {
  server.close(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
