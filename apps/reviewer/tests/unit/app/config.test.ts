import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../../../src/app/config.js';

const sandboxTemplate = `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`;

describe('server configuration', () => {
  it('derives cohesive state paths from one data directory', () => {
    expect(
      loadServerConfig({
        APP_DATA_DIRECTORY: '/workspace/.leverframe',
        APP_PORT: '6571',
        APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
        GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
        GITHUB_ALLOWED_OWNER_ID: '42',
        GITHUB_APP_NAME: 'example-leverframe-app',
        REVIEW_MODEL: 'review-model',
        REVIEW_REASONING_EFFORT: 'medium',
        REVIEW_SANDBOX_TEMPLATE: sandboxTemplate,
      }),
    ).toMatchObject({
      allowedOwnerId: 42,
      credentialsDirectory: '/workspace/.leverframe/credentials',
      databasePath: '/workspace/.leverframe/state.sqlite',
      jobsDirectory: '/workspace/.leverframe/jobs',
      githubAppName: 'example-leverframe-app',
      model: 'review-model',
      port: 6571,
      uiBaseUrl: 'https://leverframe.retn0.dev',
      webhookUrl: 'https://github.example.com/webhooks/github',
      reasoningEffort: 'medium',
      resourcesDirectory: join(process.cwd(), 'resources'),
      sandboxTemplate,
    });
  });

  it('uses the application-root resources in source mode', () => {
    expect(
      loadServerConfig({
        APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
        GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
        GITHUB_ALLOWED_OWNER_ID: '42',
        GITHUB_APP_NAME: 'example-leverframe-app',
        REVIEW_SANDBOX_TEMPLATE: sandboxTemplate,
      }).resourcesDirectory,
    ).toBe(join(process.cwd(), 'resources'));
  });

  it('validates an explicit resource directory during startup', () => {
    const resourcesDirectory = mkdtempSync(join(tmpdir(), 'leverframe-resources-'));
    mkdirSync(resourcesDirectory, { recursive: true });
    writeFileSync(join(resourcesDirectory, 'review-prompt.md'), 'Review the change.\n');
    writeFileSync(join(resourcesDirectory, 'review-schema.json'), '{"type":"object"}\n');

    try {
      expect(
        loadServerConfig({
          APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
          GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
          APP_RESOURCES_DIRECTORY: resourcesDirectory,
          GITHUB_ALLOWED_OWNER_ID: '42',
          GITHUB_APP_NAME: 'example-leverframe-app',
          REVIEW_SANDBOX_TEMPLATE: sandboxTemplate,
        }).resourcesDirectory,
      ).toBe(resourcesDirectory);
    } finally {
      rmSync(resourcesDirectory, { force: true, recursive: true });
    }
  });

  it('fails startup when a required review resource is missing', () => {
    const resourcesDirectory = mkdtempSync(join(tmpdir(), 'leverframe-resources-'));
    try {
      writeFileSync(join(resourcesDirectory, 'review-prompt.md'), 'Review the change.\n');

      expect(() =>
        loadServerConfig({
          APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
          GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
          APP_RESOURCES_DIRECTORY: resourcesDirectory,
          GITHUB_ALLOWED_OWNER_ID: '42',
          GITHUB_APP_NAME: 'example-leverframe-app',
        }),
      ).toThrow(/review-schema\.json/);
    } finally {
      rmSync(resourcesDirectory, { force: true, recursive: true });
    }
  });

  it('uses the quality-first review defaults', () => {
    expect(
      loadServerConfig({
        APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
        GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
        GITHUB_ALLOWED_OWNER_ID: '42',
        GITHUB_APP_NAME: 'example-leverframe-app',
        REVIEW_SANDBOX_TEMPLATE: sandboxTemplate,
      }),
    ).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
  });

  it('rejects unsupported reasoning effort instead of silently falling back', () => {
    expect(() =>
      loadServerConfig({
        APP_UI_BASE_URL: 'https://leverframe.retn0.dev',
        GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
        GITHUB_ALLOWED_OWNER_ID: '42',
        GITHUB_APP_NAME: 'example-leverframe-app',
        REVIEW_REASONING_EFFORT: 'automatic',
      }),
    ).toThrow();
  });

  it('requires a content-addressed local sandbox template', () => {
    const environment = {
      APP_UI_BASE_URL: 'https://leverframe.example.com',
      GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
      GITHUB_ALLOWED_OWNER_ID: '42',
      GITHUB_APP_NAME: 'example-leverframe-app',
    };
    expect(() => loadServerConfig(environment)).toThrow(/sandboxTemplate/);
    expect(() =>
      loadServerConfig({
        ...environment,
        REVIEW_SANDBOX_TEMPLATE: 'leverframe-review-sandbox:latest',
      }),
    ).toThrow(/content-addressed/);
    for (const malformedReference of [
      `ghcr.io/example/template@sha256:${'a'.repeat(64)}`,
      `leverframe-review-sandbox:sha256-${'A'.repeat(64)}`,
      `other-review-sandbox:sha256-${'a'.repeat(64)}`,
    ]) {
      expect(() =>
        loadServerConfig({
          ...environment,
          REVIEW_SANDBOX_TEMPLATE: malformedReference,
        }),
      ).toThrow(/content-addressed/);
    }
  });

  it('requires an explicit GitHub owner account', () => {
    expect(() => loadServerConfig({})).toThrow();
  });

  it('requires separate UI and webhook base URLs', () => {
    expect(() =>
      loadServerConfig({
        APP_PUBLIC_URL: 'https://legacy.example.com',
        GITHUB_ALLOWED_OWNER_ID: '42',
        GITHUB_APP_NAME: 'example-leverframe-app',
      }),
    ).toThrow();
  });

  it('rejects UI URLs that are not plain HTTP origins', () => {
    for (const value of [
      'ftp://leverframe.example.com',
      'https://leverframe.example.com/private',
      'https://leverframe.example.com/?tenant=1',
      'https://leverframe.example.com/#ui',
      'https://user:pass@leverframe.example.com',
    ]) {
      expect(() =>
        loadServerConfig({
          APP_UI_BASE_URL: value,
          GITHUB_WEBHOOK_URL: 'https://github.example.com/webhooks/github',
          GITHUB_ALLOWED_OWNER_ID: '42',
          GITHUB_APP_NAME: 'example-leverframe-app',
        }),
      ).toThrow();
    }
  });

  it('rejects webhook URLs that are not the exact public endpoint', () => {
    for (const value of [
      'ftp://github.example.com/webhooks/github',
      'https://github.example.com/webhooks/github/',
      'https://github.example.com/webhooks/other',
      'https://github.example.com/webhooks/github?token=1',
      'https://github.example.com/webhooks/github#hook',
      'https://user:pass@github.example.com/webhooks/github',
    ]) {
      expect(() =>
        loadServerConfig({
          APP_UI_BASE_URL: 'https://leverframe.example.com',
          GITHUB_WEBHOOK_URL: value,
          GITHUB_ALLOWED_OWNER_ID: '42',
          GITHUB_APP_NAME: 'example-leverframe-app',
        }),
      ).toThrow();
    }
  });
});
