import { describe, expect, it } from 'vitest';
import {
  assertSupportedSbxVersion,
  parseSbxVersion,
  sandboxCreateArguments,
} from '../../../src/sandbox/runtime.js';

describe('sandbox runtime', () => {
  it('builds an isolated create command with an immutable template', () => {
    expect(
      sandboxCreateArguments({
        name: 'review-42',
        template: `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
        workspaces: ['/tmp/workspace', '/tmp/resources:ro'],
      }),
    ).toEqual([
      'create',
      '--quiet',
      '--name',
      'review-42',
      '--cpus',
      '4',
      '--memory',
      '8g',
      '--template',
      `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
      '--no-share-skills',
      'codex',
      '/tmp/workspace',
      '/tmp/resources:ro',
    ]);
  });

  it('parses the supported Docker Sandboxes version output', () => {
    expect(parseSbxVersion('sbx version: v0.39.0 abcdef')).toBe('0.39.0');
    expect(() => parseSbxVersion('unknown')).toThrow(/determine/);
    expect(() => assertSupportedSbxVersion('0.38.0')).toThrow(/unsupported/);
    expect(() => assertSupportedSbxVersion('0.39.0')).not.toThrow();
    expect(() => assertSupportedSbxVersion('1.0.0')).not.toThrow();
  });
});
