import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  developmentRunDetailSchema,
  developmentRunListSchema,
  developmentRunSummarySchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerHooks } from '../../../src/app/server-common.js';
import { createLeverframeServer } from '../../../src/app/server.js';
import { CredentialStore } from '../../../src/github/credentials.js';
import { JobDatabase } from '../../../src/jobs/database.js';

const cleanup: Array<() => void> = [];
const sandboxTemplate = `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`;

afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close();
  }
});

async function fixture(input: { configured?: boolean; hooks?: ServerHooks } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-development-api-'));
  const credentials = new CredentialStore(directory);
  credentials.write({
    appId: 1,
    clientId: 'client',
    name: 'test',
    privateKey: 'private',
    slug: 'test',
    webhookSecret: 'long-enough-secret',
  });
  const database = new JobDatabase(':memory:');
  const server = createLeverframeServer(
    {
      allowedOwnerId: 1,
      credentialsDirectory: directory,
      databasePath: ':memory:',
      host: '127.0.0.1',
      jobsDirectory: join(directory, 'jobs'),
      githubAppName: 'test',
      model: 'model',
      port: 6571,
      uiBaseUrl: 'https://leverframe.example.test',
      webhookUrl: 'https://github.example.test/webhooks/github',
      reasoningEffort: 'low',
      resourcesDirectory: '/unused',
      sandboxTemplate,
      ...(input.configured
        ? {
            development: {
              repository: 'owner/repo',
              commitSkillDirectory: '/agent-skills/commit',
              createPrSkillDirectory: '/agent-skills/create-pr',
              verificationCommand: 'pnpm check',
            },
          }
        : {}),
    },
    database,
    credentials,
    input.hooks,
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  cleanup.push(
    () => server.close(),
    () => database.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  );
  return { database, url: `http://127.0.0.1:${address.port}` };
}

describe('development API', () => {
  it('fails closed when the local development runtime is not configured', async () => {
    const { url } = await fixture();
    const response = await fetch(`${url}/api/v1/development/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'owner/repo', goal: 'Do useful work.' }),
    });
    expect(response.status).toBe(409);
  });

  it('creates, lists, and reads a web-native run without a ticket provider', async () => {
    const onDevelopmentRunCreated = vi.fn();
    const { url } = await fixture({ configured: true, hooks: { onDevelopmentRunCreated } });
    const response = await fetch(`${url}/api/v1/development/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'owner/repo', goal: 'Do useful work.' }),
    });
    expect(response.status).toBe(201);
    const created = developmentRunSummarySchema.parse(await response.json());
    expect(created).toMatchObject({ phase: 'intake', operator_action: null });
    expect(onDevelopmentRunCreated).toHaveBeenCalledWith(created.id);

    const list = developmentRunListSchema.parse(
      await (await fetch(`${url}/api/v1/development/runs`)).json(),
    );
    expect(list.items).toEqual([created]);
    const detail = developmentRunDetailSchema.parse(
      await (await fetch(`${url}/api/v1/development/runs/${created.id}`)).json(),
    );
    expect(detail.run).toEqual(created);
    expect(detail.events[0]).toMatchObject({ type: 'run_created', trust: 'human_decided' });
    expect(JSON.stringify(detail)).not.toMatch(/(?:\/home\/|\/tmp\/|private[_ -]?key)/i);
  });

  it('accepts only the current plan approval revision', async () => {
    const onDevelopmentPlanApproval = vi.fn();
    const { database, url } = await fixture({
      configured: true,
      hooks: { onDevelopmentPlanApproval },
    });
    let run = database.development.createRun({ repository: 'owner/repo', goal: 'Plan it.' });
    run = database.development.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'PREPARING',
      event: { type: 'preparing', source: 'LEVERFRAME', trust: 'SYSTEM_OBSERVED' },
    });
    run = database.development.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'PLANNING',
      event: { type: 'planning', source: 'LEVERFRAME', trust: 'SYSTEM_OBSERVED' },
    });
    database.development.requestPlanApproval({
      runId: run.id,
      workRevisionId: run.workRevisionId,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      prompt: 'Approve?',
    });
    const interrupt = database.development.getOpenInterrupt(run.id);
    if (interrupt === undefined) {
      throw new Error('fixture interrupt missing');
    }
    const response = await fetch(`${url}/api/v1/development/runs/${run.id}/plan-approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interrupt_id: interrupt.id,
        expected_lock_version: interrupt.lockVersion,
        approve: true,
      }),
    });
    expect(response.status).toBe(202);
    expect(onDevelopmentPlanApproval).toHaveBeenCalledWith({
      runId: run.id,
      interruptId: interrupt.id,
      interruptLockVersion: interrupt.lockVersion,
      approve: true,
    });
  });

  it('replays normalized events through a terminal resumable stream', async () => {
    const { database, url } = await fixture();
    const run = database.development.createRun({ repository: 'owner/repo', goal: 'Observe it.' });
    database.development.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'FAILED',
      event: { type: 'failed_safely', source: 'LEVERFRAME', trust: 'SYSTEM_OBSERVED' },
    });
    const response = await fetch(`${url}/api/v1/development/runs/${run.id}/events?after=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).not.toContain('id: 1');
    expect(body).toContain('id: 2');
    expect(body).toContain('event: development-event');
    expect(body).toContain('event: snapshot');
  });
});
