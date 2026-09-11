import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cliEnv = { ...process.env, NODE_NO_WARNINGS: '1' };

describe('Leverframe CLI', () => {
  it('runs through the executable entry point', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
      env: cliEnv,
    });

    expect(result.stdout).toContain('leverframe/0.0.0');
  });

  it('returns a useful error for an invalid command', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'review'], {
      env: cliEnv,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Unknown command: review');
  });
});
