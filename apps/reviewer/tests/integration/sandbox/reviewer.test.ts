import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionTraceStore } from '../../../src/execution/trace.js';
import { SandboxReviewer } from '../../../src/sandbox/reviewer.js';
import { runProcess, runStreamingProcess } from '../../../src/system/process.js';

vi.mock('../../../src/system/process.js', () => ({
  runProcess: vi.fn(),
  runStreamingProcess: vi.fn(),
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SandboxReviewer', () => {
  it('stages review resources under the host-visible job directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-reviewer-'));
    temporaryDirectories.push(root);
    const resourcesDirectory = join(root, 'image-resources');
    const jobDirectory = join(root, 'shared', 'jobs', '42');
    mkdirSync(resourcesDirectory, { recursive: true });
    writeFileSync(join(resourcesDirectory, 'review-prompt.md'), 'Review carefully.\n');
    writeFileSync(join(resourcesDirectory, 'review-schema.json'), '{"type":"object"}\n');

    vi.mocked(runProcess).mockImplementation((_command, arguments_) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.39.0 test\n' });
      }
      if (arguments_[0] === 'exec' && arguments_.includes('cat')) {
        return Promise.resolve({
          stderr: '',
          stdout: '{"findings":[],"limitations":[],"summary":"No defects.","tests_run":[]}',
        });
      }
      if (arguments_.includes('rev-parse')) {
        return Promise.resolve({ stderr: '', stdout: `${'b'.repeat(40)}\n` });
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    const reviewer = new SandboxReviewer({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      resourcesDirectory,
      sandboxTemplate: `ghcr.io/example/template@sha256:${'a'.repeat(64)}`,
      traceStore: new ExecutionTraceStore(join(root, 'shared', 'jobs')),
    });
    const prepared: Array<{ prompt: string; schema: string; model: string; reasoning: string }> =
      [];
    await reviewer.review({
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      cloneUrl: 'https://github.com/owner/repository.git',
      headSha: 'b'.repeat(40),
      installationToken: 'installation-token',
      attempt: 1,
      jobDirectory,
      jobId: 42,
      pullRequestNumber: 7,
      repository: 'owner/repository',
      reviewBaseSha: 'a'.repeat(40),
      reviewMode: 'full',
      signal: new AbortController().signal,
      title: 'Test pull request',
      onPromptPrepared: (snapshot) => prepared.push(snapshot),
    });
    expect(prepared[0]).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning: 'medium',
      schema: '{"type":"object"}\n',
    });
    expect(prepared[0]?.prompt).toContain('Title: Test pull request');

    const stagedResourcesDirectory = join(jobDirectory, 'review-resources');
    expect(readFileSync(join(stagedResourcesDirectory, 'review-prompt.md'), 'utf8')).toBe(
      'Review carefully.\n',
    );
    expect(readFileSync(join(stagedResourcesDirectory, 'review-schema.json'), 'utf8')).toBe(
      '{"type":"object"}\n',
    );
    expect(existsSync(join(jobDirectory, 'sandbox-anchor'))).toBe(false);
    expect(runProcess).toHaveBeenCalledWith(
      'sbx',
      expect.arrayContaining([
        'create',
        '--template',
        `ghcr.io/example/template@sha256:${'a'.repeat(64)}`,
        '--no-share-skills',
        `${stagedResourcesDirectory}:ro`,
      ]),
      expect.any(Object),
    );
    const fetchCall = vi
      .mocked(runProcess)
      .mock.calls.find(([, arguments_]) =>
        arguments_.some((argument) => argument.includes(' fetch ')),
      );
    expect(fetchCall).toBeDefined();
    expect(fetchCall?.[1]).not.toContain('installation-token');
    expect(fetchCall?.[2]).toMatchObject({ input: 'installation-token\n' });
    const codexCall = vi.mocked(runStreamingProcess).mock.calls[0];
    expect(codexCall?.[0]).toBe('sbx');
    expect(codexCall?.[1]).toEqual(
      expect.arrayContaining([
        'codex',
        'exec',
        '--config',
        'model_reasoning_effort="medium"',
        '--output-schema',
        join(stagedResourcesDirectory, 'review-schema.json'),
        '--json',
      ]),
    );
    expect(typeof codexCall?.[2]?.input).toBe('string');
    expect(typeof codexCall?.[2]?.onStdout).toBe('function');
  });
});
