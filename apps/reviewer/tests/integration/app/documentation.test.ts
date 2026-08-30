import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLeverframeServer } from '../../../src/app/server.js';
import { CredentialStore } from '../../../src/github/credentials.js';
import { JobDatabase } from '../../../src/jobs/database.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close();
  }
});

async function fixture(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-docs-'));
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
      uiBaseUrl: 'https://leverframe.retn0.dev',
      webhookUrl: 'https://github.example.com/webhooks/github',
      reasoningEffort: 'low',
      resourcesDirectory: join(directory, 'resources'),
      sandboxTemplate: `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
      development: {
        commitSkillDirectory: '/agent-skills/commit',
        createPrSkillDirectory: '/agent-skills/create-pr',
        verificationCommand: 'pnpm check',
      },
    },
    database,
    credentials,
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  cleanup.push(
    () => server.close(),
    () => database.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  );
  return `http://127.0.0.1:${address.port}`;
}

describe('agent-readable API documentation', () => {
  it('publishes one safe OpenAPI 3.1 contract with every review operation', async () => {
    const url = await fixture();
    const response = await fetch(`${url}/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const document = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string; description: string };
      servers: Array<{ url: string }>;
      components?: { securitySchemes?: unknown };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            parameters?: Array<{ name?: string; schema?: unknown }>;
            responses?: Record<string, { description?: string }>;
          }
        >
      >;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'Leverframe Review API', version: '1.0.0' });
    expect(document.info.description).toContain('human approval');
    expect(document.info.description).toContain('lost response');
    expect(document.info.description).toContain('evaluation history');
    expect(document.servers).toEqual([
      { url: '/', description: 'Same-origin private Leverframe deployment' },
    ]);
    expect(document.components?.securitySchemes).toBeUndefined();

    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path)
        .map((operation) => operation.operationId)
        .filter((operationId): operationId is string => operationId !== undefined),
    );
    expect(operationIds).toEqual(
      expect.arrayContaining([
        'getLeverframeStatus',
        'listReviews',
        'getReview',
        'getReviewEvaluations',
        'setReviewEvaluation',
        'withdrawReviewEvaluation',
        'setFindingEvaluation',
        'withdrawFindingEvaluation',
        'getFindingContext',
        'getReviewExecution',
        'streamReviewExecution',
        'listDevelopmentRepositories',
        'listDevelopmentRuns',
        'createDevelopmentRun',
        'getDevelopmentRun',
        'answerDevelopmentClarification',
        'resolveDevelopmentPlanApproval',
        'streamDevelopmentRun',
        'resolveDevelopmentPublicationApproval',
      ]),
    );
    expect(operationIds).toHaveLength(19);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const expectedOperations = [
      ['get', '/api/v1/status', 'getLeverframeStatus', ['200']],
      ['get', '/api/v1/reviews', 'listReviews', ['200', '422']],
      ['get', '/api/v1/reviews/{reviewId}', 'getReview', ['200', '404', '422']],
      [
        'get',
        '/api/v1/reviews/{reviewId}/evaluations',
        'getReviewEvaluations',
        ['200', '404', '422'],
      ],
      [
        'put',
        '/api/v1/reviews/{reviewId}/evaluation',
        'setReviewEvaluation',
        ['200', '404', '409', '422'],
      ],
      [
        'delete',
        '/api/v1/reviews/{reviewId}/evaluation',
        'withdrawReviewEvaluation',
        ['200', '404', '409', '422'],
      ],
      [
        'put',
        '/api/v1/reviews/{reviewId}/findings/{fingerprint}/evaluation',
        'setFindingEvaluation',
        ['200', '404', '409', '422'],
      ],
      [
        'delete',
        '/api/v1/reviews/{reviewId}/findings/{fingerprint}/evaluation',
        'withdrawFindingEvaluation',
        ['200', '404', '409', '422'],
      ],
      [
        'get',
        '/api/v1/reviews/{reviewId}/findings/{fingerprint}/context',
        'getFindingContext',
        ['200', '404', '422'],
      ],
      ['get', '/api/v1/reviews/{reviewId}/execution', 'getReviewExecution', ['200', '404', '422']],
      [
        'get',
        '/api/v1/reviews/{reviewId}/execution/events',
        'streamReviewExecution',
        ['200', '404', '422'],
      ],
      [
        'get',
        '/api/v1/development/repositories',
        'listDevelopmentRepositories',
        ['200', '422', '503'],
      ],
      ['get', '/api/v1/development/runs', 'listDevelopmentRuns', ['200']],
      ['post', '/api/v1/development/runs', 'createDevelopmentRun', ['201', '409', '422', '503']],
      ['get', '/api/v1/development/runs/{runId}', 'getDevelopmentRun', ['200', '404', '422']],
      [
        'post',
        '/api/v1/development/runs/{runId}/clarification-answer',
        'answerDevelopmentClarification',
        ['202', '404', '409', '422'],
      ],
      [
        'post',
        '/api/v1/development/runs/{runId}/plan-approval',
        'resolveDevelopmentPlanApproval',
        ['202', '404', '409', '422'],
      ],
      [
        'get',
        '/api/v1/development/runs/{runId}/events',
        'streamDevelopmentRun',
        ['200', '404', '422'],
      ],
      [
        'post',
        '/api/v1/development/runs/{runId}/publication-approval',
        'resolveDevelopmentPublicationApproval',
        ['202', '404', '409', '422'],
      ],
    ] as const;
    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(expectedOperations.map(([, path]) => path))].sort(),
    );
    for (const [method, path, operationId, statuses] of expectedOperations) {
      const operation = document.paths[path]?.[method];
      expect(operation?.operationId).toBe(operationId);
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([...statuses].sort());
    }

    const listParameters = document.paths['/api/v1/reviews']?.get?.parameters ?? [];
    const pageSizeSchema = listParameters.find(
      (parameter) => parameter.name === 'page_size',
    )?.schema;
    expect(pageSizeSchema).toMatchObject({ type: 'number', const: 20, default: 20 });
    const statusSchema = listParameters.find((parameter) => parameter.name === 'status')?.schema;
    expect(JSON.stringify(statusSchema)).toContain(
      JSON.stringify(['running', 'completed', 'failed', 'superseded', 'queued', 'cancelled']),
    );
    expect(JSON.stringify(statusSchema)).not.toContain('unknown');

    const findPattern = (schema: unknown): string | undefined => {
      if (schema === null || typeof schema !== 'object') {
        return undefined;
      }
      const value = schema as Record<string, unknown>;
      if (typeof value.pattern === 'string') {
        return value.pattern;
      }
      return Object.values(value).map(findPattern).find(Boolean);
    };

    const commaSeparatedStatusPattern = findPattern(statusSchema);
    expect(commaSeparatedStatusPattern).toBeDefined();
    expect(new RegExp(commaSeparatedStatusPattern ?? '').test('completed,failed')).toBe(true);
    expect(commaSeparatedStatusPattern).not.toContain('/i');
    expect(
      document.paths['/api/v1/reviews/{reviewId}/evaluation']?.delete?.responses?.['422']
        ?.description,
    ).toContain('INVALID_EVALUATION');

    const serialized = JSON.stringify(document);
    expect(serialized).toContain('expected_previous_id');
    expect(serialized).toContain('false_positive');
    expect(serialized).toContain('STALE_EVALUATION');
    expect(serialized).not.toMatch(
      /(?:leverframe\.retn0\.dev|\/home\/retn0|private[_ -]?key|webhook[_ -]?secret)/i,
    );
  });

  it('serves Scalar and a cached Markdown contract from the same OpenAPI document', async () => {
    const url = await fixture();
    for (const path of ['/docs', '/docs/']) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('Leverframe Review API');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('/openapi.json');
      expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
      const scalarScriptPath = html.match(
        /<script src="(\/docs\/assets\/scalar-[0-9a-f]{16}\.js)">/,
      )?.[1];
      expect(scalarScriptPath).toBeDefined();
      const scalarScript = await fetch(`${url}${scalarScriptPath}`);
      expect(scalarScript.status).toBe(200);
      expect(scalarScript.headers.get('content-type')).toContain('text/javascript');
      expect(scalarScript.headers.get('cache-control')).toContain('immutable');
      expect(await scalarScript.text()).toContain('Scalar');
    }

    const first = await fetch(`${url}/llms.txt`);
    const second = await fetch(`${url}/llms.txt`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/markdown');
    const firstMarkdown = await first.text();
    expect(await second.text()).toBe(firstMarkdown);
    expect(firstMarkdown).toContain('/api/v1/reviews/{reviewId}/evaluation');
    expect(firstMarkdown).toContain('human-approved overall judgment');
    expect(firstMarkdown).toContain('expected_previous_id');
    expect(firstMarkdown).toContain('false_positive');
    expect(firstMarkdown).toContain('Status: 409');
    expect(firstMarkdown).not.toMatch(
      /(?:leverframe\.retn0\.dev|\/home\/retn0|private[_ -]?key|webhook[_ -]?secret)/i,
    );
  });
});
