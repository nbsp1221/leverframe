import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  connectorClientConfigSchema,
  coreRequest,
  startConnector,
  validateCoreUrl,
} from './client.js';

const assets = dirname(fileURLToPath(import.meta.url));
const stateRoot =
  process.env.LEVERFRAME_CONNECTOR_HOME ??
  join(homedir(), '.local', 'share', 'leverframe-connector');
const configFile = join(stateRoot, 'config.json');
const pidFile = join(stateRoot, 'connector.pid');
const args = parseArgs({
  allowPositionals: true,
  options: {
    'url': { type: 'string' },
    'code': { type: 'string' },
    'locale': { type: 'string' },
    'name': { type: 'string' },
    'port': { type: 'string' },
    'socket': { type: 'string' },
    'skill-root': { type: 'string' },
  },
});
const command = args.positionals[0];

function writePrivate(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function alive(): boolean {
  try {
    const recorded = readFileSync(pidFile, 'utf8');
    const pid = Number(recorded);
    if (Number.isInteger(pid) && pid >= 2 && ownsPid(pid)) {
      return true;
    }
    // Remove only our stale record, never signal the process that reused this PID.
    if (readFileSync(pidFile, 'utf8') === recorded) {
      rmSync(pidFile);
    }
    return false;
  } catch {
    return false;
  }
}

function ownsPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return (
      realpathSync(`/proc/${pid}/exe`) === realpathSync(process.execPath) &&
      argv[1] === join(assets, 'connector.js') &&
      argv[2] === 'run'
    );
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  if (command === 'connect') {
    const locale = z.enum(['en', 'ko']).parse(args.values.locale ?? 'ko');
    const previous = existsSync(configFile)
      ? connectorClientConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')))
      : undefined;
    if (previous) {
      try {
        await coreRequest(previous.url, 'agent/status', {}, previous.token);
        throw new Error('already_connected_use_start');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'core_http_401') {
          throw error;
        }
      }
      if (alive()) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (!ownsPid(pid)) {
          throw new Error('pid_identity_changed');
        }
        process.kill(pid, 'SIGTERM');
        for (let attempt = 0; attempt < 40 && alive(); attempt++) {
          await sleep(250);
        }
        if (alive()) {
          throw new Error('connector_still_stopping');
        }
      }
    }
    const url = validateCoreUrl(args.values.url ?? '');
    if (!args.values.code) {
      throw new Error('pairing_code_required');
    }
    const skillRoot = args.values['skill-root'] ?? join(homedir(), '.agents', 'skills');
    const skillPath = previous?.skillPath ?? join(skillRoot, 'leverframe-ask');
    if (existsSync(skillPath)) {
      const installed = JSON.parse(readFileSync(join(skillPath, 'connection.json'), 'utf8')) as {
        token: string;
      };
      if (!previous || installed.token !== previous.localToken) {
        throw new Error('skill_exists_not_overwritten');
      }
    }
    const identity = z.object({ id: z.string(), token: z.string() }).parse(
      await coreRequest(url, 'enroll', {
        code: args.values.code,
        name: args.values.name ?? hostname(),
        hostname: hostname(),
      }),
    );
    const config = connectorClientConfigSchema.parse({
      ...identity,
      url,
      localToken: randomBytes(32).toString('base64url'),
      port: Number(args.values.port ?? previous?.port ?? 16729),
      skillPath,
      ...(args.values.socket || previous?.socketPath
        ? { socketPath: args.values.socket ?? previous?.socketPath }
        : {}),
    });
    writePrivate(configFile, config);
    cpSync(join(assets, 'leverframe-ask'), skillPath, {
      recursive: true,
      errorOnExist: !previous,
      force: Boolean(previous),
    });
    writePrivate(join(skillPath, 'connection.json'), {
      url: `http://127.0.0.1:${config.port}`,
      token: config.localToken,
      uiUrl: `${url}/${locale}/decisions`,
    });
    console.log(
      'Connected. Skill installed for this user. Start the connector to receive questions.',
    );
  } else if (command === 'run') {
    const config = connectorClientConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
    if (alive()) {
      throw new Error('connector_already_running');
    }
    writeFileSync(pidFile, String(process.pid), { mode: 0o600, flag: 'wx' });
    const client = startConnector(config, assets);

    const cleanup = () => {
      try {
        if (readFileSync(pidFile, 'utf8') === String(process.pid)) {
          rmSync(pidFile);
        }
      } catch {
        /* Already removed. */
      }
    };

    client.server.on('error', () => {
      cleanup();
      console.error('Local connector port unavailable');
      process.exit(1);
    });
    process.on('exit', cleanup);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void client.close().finally(() => process.exit(0));
      });
    }
    console.log('Connector running.');
  } else if (command === 'start') {
    if (alive()) {
      console.log('Connector already running.');
      return;
    }
    rmSync(pidFile, { force: true });
    const log = openSync(join(stateRoot, 'connector.log'), 'a', 0o600);
    const child = spawn(process.execPath, [join(assets, 'connector.js'), 'run'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    console.log('Connector starting in the background. Check its status in Leverframe.');
  } else if (command === 'stop') {
    if (alive()) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      // On Linux, validate ownership before signaling a PID that could have been reused.
      if (!ownsPid(pid)) {
        throw new Error('pid_identity_changed');
      }
      process.kill(pid, 'SIGTERM');
    }
  } else if (command === 'uninstall') {
    if (alive()) {
      throw new Error('stop_connector_first');
    }
    const config = connectorClientConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
    const connection = JSON.parse(
      readFileSync(join(config.skillPath, 'connection.json'), 'utf8'),
    ) as { token: string };
    if (connection.token !== config.localToken) {
      throw new Error('skill_ownership_changed');
    }
    rmSync(config.skillPath, { recursive: true });
    rmSync(configFile);
    console.log(
      'Local identity and skill removed. Revoke the computer in Leverframe; saved questions remain.',
    );
  } else if (command === 'status') {
    console.log(alive() ? 'running' : 'stopped');
  } else {
    console.log(
      'Leverframe connector: connect --url URL --code CODE | start | run | stop | status | uninstall',
    );
    console.log(`Installation: ${realpathSync(assets)}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'connector_failed');
  process.exitCode = 1;
});
