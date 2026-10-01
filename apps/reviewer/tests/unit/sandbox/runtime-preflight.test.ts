import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectSandboxRuntime,
  preflightSandboxRuntime,
  sandboxRuntimeAvailable,
} from '../../../src/sandbox/runtime.js';
import { runProcess } from '../../../src/system/process.js';

vi.mock('../../../src/system/process.js', () => ({
  runProcess: vi.fn(),
}));

const template = `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`;

describe('sandbox runtime preflight', () => {
  let hostVisibleWorkspaceRoot: string;
  let testDirectory: string;

  beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), 'leverframe-preflight-test-'));
    hostVisibleWorkspaceRoot = join(testDirectory, 'jobs');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    rmSync(testDirectory, { force: true, recursive: true });
  });

  it('accepts slow CLI startup while keeping interactive health probes bounded', async () => {
    vi.useFakeTimers();
    vi.mocked(runProcess).mockImplementation((_command, arguments_, options) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.45.1 build' });
      }
      const startupMilliseconds = 6_000;
      const deadline = options?.timeoutMilliseconds ?? Number.POSITIVE_INFINITY;
      return new Promise((resolve, reject) => {
        setTimeout(
          () => {
            if (deadline < startupMilliseconds) {
              reject(new Error('CLI startup timed out'));
            } else {
              resolve({ stderr: '', stdout: 'Status: running' });
            }
          },
          Math.min(startupMilliseconds, deadline),
        );
      });
    });

    const startup = inspectSandboxRuntime(template);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(startup).resolves.toEqual({ cliVersion: '0.45.1', template });

    const health = sandboxRuntimeAvailable(template);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(health).resolves.toBe(false);
  });

  it('cleans up a partially created sandbox after startup is cancelled', async () => {
    const controller = new AbortController();
    let workspace = '';
    let sandboxName = '';
    vi.mocked(runProcess).mockImplementation((_command, arguments_, options) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.45.1 build' });
      }
      if (arguments_[0] === 'create') {
        workspace = arguments_.at(-1) ?? '';
        sandboxName = arguments_[arguments_.indexOf('--name') + 1] ?? '';
        expect(options?.signal).toBe(controller.signal);
        controller.abort();
        return Promise.reject(new Error('startup cancelled'));
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    await expect(
      preflightSandboxRuntime(template, hostVisibleWorkspaceRoot, controller.signal),
    ).rejects.toThrow('startup cancelled');
    expect(existsSync(workspace)).toBe(false);
    expect(runProcess).toHaveBeenLastCalledWith('sbx', ['rm', '--force', sandboxName], {
      timeoutMilliseconds: 2 * 60 * 1000,
    });
  });

  it('proves the disposable environment and removes its workspace and sandbox', async () => {
    let workspace = '';
    let sandboxName = '';
    vi.mocked(runProcess).mockImplementation((_command, arguments_) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.39.0 build' });
      }
      if (arguments_[0] === 'create') {
        sandboxName = arguments_[arguments_.indexOf('--name') + 1] ?? '';
        workspace = arguments_.at(-1) ?? '';
        expect(existsSync(workspace)).toBe(true);
        expect(dirname(workspace)).toBe(hostVisibleWorkspaceRoot);
      }
      if (arguments_[0] === 'exec') {
        return Promise.resolve({
          stderr: '',
          stdout: 'node=v24.20.0\nshared_skills=disabled\n',
        });
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    await expect(preflightSandboxRuntime(template, hostVisibleWorkspaceRoot)).resolves.toContain(
      'shared_skills=disabled',
    );

    expect(existsSync(hostVisibleWorkspaceRoot)).toBe(true);
    expect(statSync(hostVisibleWorkspaceRoot).mode & 0o777).toBe(0o700);
    expect(existsSync(workspace)).toBe(false);
    expect(runProcess).toHaveBeenLastCalledWith('sbx', ['rm', '--force', sandboxName], {
      timeoutMilliseconds: 2 * 60 * 1000,
    });
  });

  it('still removes the disposable sandbox and workspace when its probe fails', async () => {
    let workspace = '';
    let sandboxName = '';
    vi.mocked(runProcess).mockImplementation((_command, arguments_) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.39.0 build' });
      }
      if (arguments_[0] === 'create') {
        sandboxName = arguments_[arguments_.indexOf('--name') + 1] ?? '';
        workspace = arguments_.at(-1) ?? '';
      }
      if (arguments_[0] === 'exec') {
        return Promise.reject(new Error('probe failed'));
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    await expect(preflightSandboxRuntime(template, hostVisibleWorkspaceRoot)).rejects.toThrow(
      'probe failed',
    );

    expect(existsSync(workspace)).toBe(false);
    expect(runProcess).toHaveBeenLastCalledWith('sbx', ['rm', '--force', sandboxName], {
      timeoutMilliseconds: 2 * 60 * 1000,
    });
  });

  it('removes the workspace even when sandbox cleanup fails', async () => {
    let workspace = '';
    vi.mocked(runProcess).mockImplementation((_command, arguments_) => {
      if (arguments_[0] === 'version') {
        return Promise.resolve({ stderr: '', stdout: 'sbx version: v0.39.0 build' });
      }
      if (arguments_[0] === 'create') {
        workspace = arguments_.at(-1) ?? '';
      }
      if (arguments_[0] === 'exec') {
        return Promise.resolve({ stderr: '', stdout: 'shared_skills=disabled' });
      }
      if (arguments_[0] === 'rm') {
        return Promise.reject(new Error('cleanup failed'));
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    await expect(preflightSandboxRuntime(template, hostVisibleWorkspaceRoot)).rejects.toThrow(
      'cleanup failed',
    );
    expect(existsSync(workspace)).toBe(false);
  });
});
