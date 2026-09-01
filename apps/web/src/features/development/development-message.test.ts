import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePaths } from './development-message';

describe('normalizeWorkspacePaths', () => {
  it('shows repository-relative file references instead of sandbox paths', () => {
    expect(
      normalizeWorkspacePaths(
        '현재 [README.md](/home/[redacted]/repositories/nbsp1221/leverframe/development/4/workspace/README.md:22)을 확인했습니다.',
      ),
    ).toBe('현재 [README.md](README.md:22)을 확인했습니다.');
  });

  it('preserves ordinary paths that are not workspace internals', () => {
    expect(normalizeWorkspacePaths('Run pnpm from apps/web and inspect /api/v1/status.')).toBe(
      'Run pnpm from apps/web and inspect /api/v1/status.',
    );
  });
});
