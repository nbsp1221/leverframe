import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../system/process.js';

const minimumSbxVersion = [0, 39, 0] as const;

export interface SandboxRuntimeIdentity {
  cliVersion: string;
  template: string;
}

export function sandboxCreateArguments(input: {
  name: string;
  template: string;
  workspaces: readonly string[];
  cpus?: number;
  memory?: string;
}): string[] {
  return [
    'create',
    '--quiet',
    '--name',
    input.name,
    '--cpus',
    String(input.cpus ?? 4),
    '--memory',
    input.memory ?? '8g',
    '--template',
    input.template,
    '--no-share-skills',
    'codex',
    ...input.workspaces,
  ];
}

export async function inspectSandboxRuntime(template: string): Promise<SandboxRuntimeIdentity> {
  const version = await runProcess('sbx', ['version'], { timeoutMilliseconds: 5_000 });
  const cliVersion = parseSbxVersion(version.stdout);
  assertSupportedSbxVersion(cliVersion);
  await runProcess('sbx', ['daemon', 'status'], { timeoutMilliseconds: 5_000 });
  return { cliVersion, template };
}

export async function sandboxRuntimeAvailable(template: string): Promise<boolean> {
  try {
    await inspectSandboxRuntime(template);
    return true;
  } catch {
    return false;
  }
}

export async function preflightSandboxRuntime(template: string): Promise<string> {
  const identity = await inspectSandboxRuntime(template);
  const workspace = mkdtempSync(join(tmpdir(), 'leverframe-sandbox-preflight-'));
  const name = `leverframe-preflight-${randomUUID().slice(0, 12)}`;
  let created = false;
  try {
    await runProcess(
      'sbx',
      sandboxCreateArguments({
        name,
        template,
        workspaces: [workspace],
        cpus: 2,
        memory: '4g',
      }),
      { timeoutMilliseconds: 5 * 60 * 1000 },
    );
    created = true;
    const evidence = await probeSandboxEnvironment(name);
    return `template=${identity.template}\nsbx=${identity.cliVersion}\n${evidence}`;
  } finally {
    try {
      const cleanup = runProcess('sbx', ['rm', '--force', name], {
        timeoutMilliseconds: 2 * 60 * 1000,
      });
      if (created) {
        await cleanup;
      } else {
        await cleanup.catch(() => undefined);
      }
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  }
}

export async function probeSandboxEnvironment(name: string, signal?: AbortSignal): Promise<string> {
  const result = await runProcess(
    'sbx',
    ['exec', name, '/usr/local/bin/leverframe-sandbox-smoke', 'sandbox'],
    {
      ...(signal === undefined ? {} : { signal }),
      timeoutMilliseconds: 2 * 60 * 1000,
    },
  );
  return result.stdout.trim();
}

export function parseSbxVersion(value: string): string {
  const match = /\bsbx version:\s*v(\d+\.\d+\.\d+)\b/.exec(value);
  if (match?.[1] === undefined) {
    throw new Error('Unable to determine the Docker Sandboxes CLI version.');
  }
  return match[1];
}

export function assertSupportedSbxVersion(value: string): void {
  const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number);
  const [minimumMajor, minimumMinor, minimumPatch] = minimumSbxVersion;
  const supported =
    major > minimumMajor ||
    (major === minimumMajor && minor > minimumMinor) ||
    (major === minimumMajor && minor === minimumMinor && patch >= minimumPatch);
  if (!supported) {
    throw new Error(
      `Docker Sandboxes CLI ${value} is unsupported; version 0.39.0 or newer is required.`,
    );
  }
}
