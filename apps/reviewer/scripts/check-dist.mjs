import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Workspace symlinks hide unresolved TypeScript package imports; test the shipped layout.
const directory = mkdtempSync(join(tmpdir(), 'leverframe-dist-'));
try {
  execFileSync('pnpm', ['--filter', '@repo/reviewer', 'deploy', '--prod', directory], {
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [join(directory, 'dist/cli.js'), '--version'], {
    cwd: directory,
    stdio: 'inherit',
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
