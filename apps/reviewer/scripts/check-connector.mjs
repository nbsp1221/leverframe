import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Exercise the shipped CLI with private temporary state, never the user's installation.
const execute = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'leverframe-connector-check-'));
const binary = fileURLToPath(new URL('../dist/connector/bundle/connector.js', import.meta.url));
const core = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ id: 'test-computer', token: 't'.repeat(32), commands: [] }));
});
await new Promise((resolve) => {
  core.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${core.address().port}`;
const reservation = createServer();
await new Promise((resolve) => {
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => {
  reservation.close(resolve);
});
const env = { ...process.env, LEVERFRAME_CONNECTOR_HOME: root };

const run = async (...args) =>
  (await execute(process.execPath, [binary, ...args], { env, timeout: 10_000 })).stdout.trim();

const pidFile = join(root, 'connector.pid');
const skillPath = join(root, 'skills/leverframe-ask');

const waitFor = async (status) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await run('status')) === status) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Connector did not become ${status}`);
};

try {
  for (const locale of ['en', 'ko', undefined]) {
    await run(
      'connect',
      '--url',
      url,
      '--code',
      'test-code',
      '--skill-root',
      join(root, 'skills'),
      '--port',
      String(port),
      ...(locale ? ['--locale', locale] : []),
    );
    const connection = JSON.parse(readFileSync(join(skillPath, 'connection.json'), 'utf8'));
    assert.equal(connection.uiUrl, `${url}/${locale ?? 'ko'}/decisions`);
    assert.equal(connection.url, `http://127.0.0.1:${port}`);

    // This very process is alive and uses the same Node executable, but is NOT the connector.
    writeFileSync(pidFile, String(process.pid));
    assert.equal(await run('status'), 'stopped');
    assert.equal(existsSync(pidFile), false);
    writeFileSync(pidFile, String(process.pid));
    await run('stop');
    process.kill(process.pid, 0);

    writeFileSync(pidFile, String(process.pid));
    await run('start');
    await waitFor('running');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.notEqual(pid, process.pid);
    assert.match(await run('start'), /already running/);
    assert.equal(Number(readFileSync(pidFile, 'utf8')), pid);
    await assert.rejects(run('uninstall'), /stop_connector_first/);
    await run('stop');
    await waitFor('stopped');

    writeFileSync(pidFile, String(process.pid));
    await run('uninstall');
    assert.equal(existsSync(skillPath), false);
    assert.equal(existsSync(join(root, 'config.json')), false);
    process.kill(process.pid, 0);
  }
  await assert.rejects(
    run('connect', '--url', url, '--code', 'test-code', '--locale', 'unsupported'),
  );
  assert.equal(existsSync(join(root, 'config.json')), false);
  console.log('Packaged connector: locales, stale PID recovery, ownership and lifecycle passed');
} finally {
  await run('stop').catch(() => {});
  await waitFor('stopped').catch(() => {});
  await new Promise((resolve) => {
    core.close(resolve);
  });
  rmSync(root, { recursive: true, force: true });
}
