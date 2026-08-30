import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DevelopmentSandboxManager,
  assertTaskBranch,
  parseWorkspaceStatus,
} from '../../../src/sandbox/development.js';
import { runProcess } from '../../../src/system/process.js';

vi.mock('../../../src/system/process.js', () => ({ runProcess: vi.fn() }));

const roots: string[] = [];
const template = `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`;
const baseSha = 'b'.repeat(40);

function manager() {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-development-manager-'));
  roots.push(root);
  const commitSkillDirectory = join(root, 'source-skills', 'commit');
  const createPrSkillDirectory = join(root, 'source-skills', 'create-pr');
  mkdirSync(commitSkillDirectory, { recursive: true });
  mkdirSync(createPrSkillDirectory, { recursive: true });
  writeFileSync(join(commitSkillDirectory, 'SKILL.md'), '# Commit\n', { mode: 0o600 });
  writeFileSync(join(createPrSkillDirectory, 'SKILL.md'), '# Create PR\n', { mode: 0o600 });
  return new DevelopmentSandboxManager({
    dataDirectory: join(root, 'data'),
    sandboxTemplate: template,
    commitSkillDirectory,
    createPrSkillDirectory,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

describe('DevelopmentSandboxManager', () => {
  it('grants and revokes a run-scoped GitHub publication capability', async () => {
    const sandboxManager = manager();
    sandboxManager.paths(1, true);
    vi.mocked(runProcess).mockImplementation((command, arguments_) =>
      Promise.resolve({
        stdout:
          command === 'sbx' && arguments_.includes('check')
            ? '{"allowed":true}'
            : command === 'sh'
              ? '{"allowed":false}'
              : '',
        stderr: '',
      }),
    );

    await sandboxManager.enablePublication(1);
    await sandboxManager.disablePublication(1);

    expect(runProcess).toHaveBeenCalledWith('sbx', [
      'secret',
      'set',
      'github',
      '--sandbox',
      'leverframe-dev-1',
      '--command',
      'gh auth token',
    ]);
    expect(runProcess).toHaveBeenCalledWith('sbx', [
      'secret',
      'rm',
      'github',
      '--sandbox',
      'leverframe-dev-1',
      '--force',
    ]);
  });

  it('creates a private workspace with a read-only-mounted skill snapshot and credential-free arguments', async () => {
    const sandboxManager = manager();
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'sandbox ready', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{"allowed":false}', stderr: '' })
      .mockResolvedValueOnce({
        stdout: `# branch.oid ${baseSha}\n# branch.head codex/per-59\n`,
        stderr: '',
      });

    const prepared = await sandboxManager.prepare({
      runId: 59,
      branch: 'codex/per-59',
      cloneUrl: 'https://github.com/example/leverframe.git',
      baseSha,
      readToken: 'secret-read-token',
    });

    expect(prepared.name).toBe('leverframe-dev-59');
    expect(readFileSync(join(prepared.skillsDirectory, 'commit', 'SKILL.md'), 'utf8')).toBe(
      '# Commit\n',
    );
    const createCall = vi.mocked(runProcess).mock.calls[0];
    expect(createCall?.[0]).toBe('sbx');
    expect(createCall?.[1]).toContain(`${prepared.skillsDirectory}:ro`);
    expect(createCall?.[1]).not.toContain('--deny-network');
    expect(JSON.stringify(createCall)).not.toContain('secret-read-token');
    const fetchCall = vi.mocked(runProcess).mock.calls[3];
    expect(fetchCall?.[1]).not.toContain('secret-read-token');
    expect(fetchCall?.[2]).toMatchObject({ input: 'secret-read-token\n' });
    expect(vi.mocked(runProcess).mock.calls[4]?.[1]).toEqual([
      'policy',
      'deny',
      'network',
      '--sandbox',
      'leverframe-dev-59',
      'github.com,api.github.com',
    ]);
    expect(vi.mocked(runProcess).mock.calls[5]?.[0]).toBe('sh');
    expect(vi.mocked(runProcess).mock.calls[5]?.[1]).toContain('leverframe-dev-59');
  });

  it('rejects unsafe branches, credential-bearing remotes, and destructive cleanup before integration', async () => {
    const sandboxManager = manager();
    expect(() => assertTaskBranch('main')).toThrow(/codex/);
    expect(() => assertTaskBranch('codex/../main')).toThrow(/safe/);
    await expect(
      sandboxManager.prepare({
        runId: 1,
        branch: 'codex/safe',
        cloneUrl: 'https://token@github.com/example/repo.git',
        baseSha,
        readToken: 'unused',
      }),
    ).rejects.toThrow(/credential-free/);
    await expect(
      sandboxManager.cleanup({ runId: 1, expectedBranch: 'codex/safe', integrated: false }),
    ).rejects.toThrow(/integrated/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('parses branch identity separately from dirty state', () => {
    expect(
      parseWorkspaceStatus(
        `# branch.oid ${baseSha}\n# branch.head codex/per-59\n1 .M N... 100644 100644 100644 ${'c'.repeat(40)} ${'c'.repeat(40)} src/index.ts\n`,
      ),
    ).toEqual({ branch: 'codex/per-59', headSha: baseSha, dirty: true });
    expect(() => parseWorkspaceStatus('# branch.oid (initial)\n# branch.head main\n')).toThrow(
      /identity/,
    );
  });

  it('hashes committed, staged, unstaged, untracked, and submodule candidate state without changing the index', async () => {
    const sandboxManager = manager();
    sandboxManager.paths(7, true);
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ stdout: `${baseSha}\n`, stderr: '' })
      .mockResolvedValueOnce({
        stdout: `# branch.oid ${baseSha}${'\0'}# branch.head codex/candidate${'\0'}1 .M N... src/index.ts${'\0'}`,
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'unstaged diff', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'staged diff', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'submodule state', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'untracked hash manifest', stderr: '' });

    const candidate = await sandboxManager.candidateIdentity(7);

    expect(candidate).toMatchObject({ dirty: true, headSha: baseSha });
    expect(candidate.hash).toMatch(/^[0-9a-f]{64}$/);
    const commands = vi.mocked(runProcess).mock.calls.map((call) => call[1]?.join(' '));
    expect(commands.some((command) => command?.includes('git add'))).toBe(false);
  });
});
