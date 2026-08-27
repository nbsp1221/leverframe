import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightSandboxRuntime } from '../../../src/sandbox/runtime.js';
import { runProcess } from '../../../src/system/process.js';

vi.mock('../../../src/system/process.js', () => ({
  runProcess: vi.fn(),
}));

const template = `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`;

describe('sandbox runtime preflight', () => {
  afterEach(() => {
    vi.resetAllMocks();
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
      }
      if (arguments_[0] === 'exec') {
        return Promise.resolve({
          stderr: '',
          stdout: 'node=v24.20.0\nshared_skills=disabled\n',
        });
      }
      return Promise.resolve({ stderr: '', stdout: '' });
    });

    await expect(preflightSandboxRuntime(template)).resolves.toContain('shared_skills=disabled');

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

    await expect(preflightSandboxRuntime(template)).rejects.toThrow('probe failed');

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

    await expect(preflightSandboxRuntime(template)).rejects.toThrow('cleanup failed');
    expect(existsSync(workspace)).toBe(false);
  });
});
