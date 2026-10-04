import { timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ConnectorCommand,
  type ConnectorResult,
  connectorCommandSchema,
} from '@repo/contracts/connectors';
import { z } from 'zod';
import { AcpSessionChannel } from '../agent-connections/acp-channel.js';
import { CodexObserverRpc } from '../agent-connections/codex-observer-rpc.js';
import { CodexSessionObserver } from '../agent-connections/codex-observer.js';
import { type PreparedSession, UnsupportedSessionChannel } from '../agent-connections/ports.js';

export const connectorClientConfigSchema = z.object({
  url: z.url(),
  id: z.string(),
  token: z.string().min(32),
  localToken: z.string().min(32),
  port: z.number().int().min(1).max(65535),
  skillPath: z.string(),
  socketPath: z.string().optional(),
});

export type ConnectorClientConfig = z.infer<typeof connectorClientConfigSchema>;

export function validateCoreUrl(value: string) {
  const url = new URL(value);
  // Private deployments are explicitly supported. Never send credentials to public plaintext endpoints.
  const host = url.hostname;
  const privateHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    (isIP(host) === 4 &&
      (host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)));
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && privateHost))
  ) {
    throw new Error('https_or_private_network_required');
  }
  return url.toString().replace(/\/$/, '');
}

export async function coreRequest(
  base: string,
  path: string,
  body: unknown,
  token?: string,
  timeout = 25_000,
): Promise<unknown> {
  const response = await fetch(`${validateCoreUrl(base)}/api/v1/connectors/${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`core_http_${response.status}`);
  }
  return response.json();
}

export function discoverCodexSocket(configured?: string): string {
  if (configured) {
    if (statSync(configured).isSocket()) {
      return configured;
    }
    throw new Error('codex_socket_missing');
  }
  const root = `/tmp/codex-daemon-${process.getuid?.() ?? ''}`;
  const sockets = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isSocket());
  if (sockets.length !== 1) {
    throw new Error('codex_socket_missing_or_ambiguous');
  }
  return sockets[0]!;
}

export function startConnector(config: ConnectorClientConfig, assets: string) {
  let stopped = false;
  const tasks = new Set<Promise<void>>();
  const preparedSessions = new Map<
    string,
    { session: PreparedSession; sessionId: string; cwd: string; expires: number }
  >();

  const channel = (timeoutMs = 60_000) =>
    new AcpSessionChannel(
      {
        kind: 'stdio',
        command: process.execPath,
        args: [join(assets, 'codex-acp.mjs')],
        env: {
          CODEX_PATH: join(assets, 'desktop-bridge.js'),
          LEVERFRAME_CODEX_SOCKET: discoverCodexSocket(config.socketPath),
        },
      },
      timeoutMs,
    );

  const resolveSession = async (sessionId: string, expectedCwd?: string) => {
    const rpc = new CodexObserverRpc(discoverCodexSocket(config.socketPath));
    const { thread } = z
      .object({ thread: z.object({ id: z.string(), cwd: z.string() }) })
      .parse(await rpc.call('thread/read', { threadId: sessionId, includeTurns: false }));
    if (thread.id !== sessionId || (expectedCwd && thread.cwd !== expectedCwd)) {
      throw new Error('session_identity_changed');
    }
    return {
      rpc,
      cwd: thread.cwd,
      observer: new CodexSessionObserver(rpc, new Map([[sessionId, thread.cwd]])),
    };
  };

  const execute = async (command: ConnectorCommand): Promise<ConnectorResult> => {
    try {
      const target = await resolveSession(command.sessionId, command.cwd);
      if (command.kind === 'read') {
        let snapshot = await target.observer.read(command.sessionId);
        if (
          snapshot.state === 'offline' &&
          snapshot.revision &&
          !(await target.observer.isLoaded(command.sessionId))
        ) {
          // ACP load restores this exact existing session without prompting or executing a turn.
          // Never replace an active loaded session; normal preparation and checkpoint checks still follow.
          const lease = await channel(15_000).prepare(command.sessionId, target.cwd);
          try {
            snapshot = await target.observer.read(command.sessionId);
          } finally {
            await lease.close();
          }
        }
        return { ok: true, snapshot: { ...snapshot, messages: [...snapshot.messages] } };
      }
      if (command.kind === 'prepare') {
        const session = await channel().prepare(command.sessionId, target.cwd);
        preparedSessions.set(command.id, {
          session,
          sessionId: command.sessionId,
          cwd: target.cwd,
          expires: Date.now() + 120_000,
        });
        return { ok: true, preparedId: command.id };
      }
      const prepared = preparedSessions.get(command.preparedId ?? '');
      if (command.kind === 'close') {
        if (prepared) {
          preparedSessions.delete(command.preparedId!);
          await prepared.session.close();
        }
        return { ok: true };
      }
      if (
        !prepared ||
        prepared.sessionId !== command.sessionId ||
        prepared.cwd !== target.cwd ||
        prepared.expires < Date.now()
      ) {
        return { ok: false, error: 'unconfirmed' };
      }
      try {
        await coreRequest(
          config.url,
          `agent/authorize/${encodeURIComponent(command.id)}`,
          {},
          config.token,
        );
        const snapshot = await target.observer.read(command.sessionId);
        if (snapshot.state !== 'ready') {
          return { ok: false, error: snapshot.state === 'busy' ? 'busy' : 'offline' };
        }
        await prepared.session.send(command.message!);
        return { ok: true };
      } finally {
        preparedSessions.delete(command.preparedId!);
        await prepared.session.close();
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof UnsupportedSessionChannel
            ? 'unsupported'
            : command.kind === 'send'
              ? 'unconfirmed'
              : 'offline',
      };
    }
  };

  const handle = async (command: ConnectorCommand) => {
    const result = await execute(command);
    // Only receipt publication retries. The execution itself is never repeated.
    for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
      const published = await coreRequest(
        config.url,
        `agent/results/${encodeURIComponent(command.id)}`,
        result,
        config.token,
      ).then(
        () => true,
        () => false,
      );
      if (published) {
        return;
      }
      await sleep(1000);
    }
  };

  let codex: 'ready' | 'unavailable' = 'unavailable';
  let lastProbe = 0;
  let probe: Promise<void> | undefined;
  const loop = (async () => {
    while (!stopped) {
      for (const [key, prepared] of preparedSessions) {
        if (prepared.expires < Date.now()) {
          preparedSessions.delete(key);
          await prepared.session.close();
        }
      }
      try {
        if (!probe && Date.now() - lastProbe > 10_000) {
          lastProbe = Date.now();
          probe = (async () => {
            try {
              await new CodexObserverRpc(discoverCodexSocket(config.socketPath)).call(
                'thread/loaded/list',
                {},
              );
              codex = 'ready';
            } catch {
              codex = 'unavailable';
            }
          })().finally(() => {
            probe = undefined;
          });
        }
        const health = {
          codex,
          skill: ['SKILL.md', 'scripts/ask.py', 'connection.json'].every((file) =>
            existsSync(join(config.skillPath, file)),
          )
            ? 'installed'
            : 'missing',
        };
        const value = z
          .object({ commands: z.array(connectorCommandSchema) })
          .parse(await coreRequest(config.url, 'agent/poll', health, config.token));
        for (const command of value.commands) {
          const task = handle(command).finally(() => tasks.delete(task));
          tasks.add(task);
        }
      } catch {
        /* Core restarts/offline/revocation do not discard local configuration. */
      }
      await sleep(1000);
    }
  })();
  const server = createServer((request, response) => {
    void (async () => {
      const actual = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${config.localToken}`);
      if (
        request.method !== 'POST' ||
        request.url !== '/api/v1/decisions' ||
        request.headers.origin ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        response.writeHead(403).end();
        return;
      }
      let raw = '';
      for await (const chunk of request) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > 65536) {
          response.writeHead(413).end();
          return;
        }
      }
      const parsed = z
        .object({ threadId: z.string().min(1).max(200) })
        .passthrough()
        .safeParse(JSON.parse(raw));
      if (!parsed.success || 'source' in parsed.data) {
        response.writeHead(422).end();
        return;
      }
      const { threadId, ...question } = parsed.data;
      const target = await resolveSession(threadId);
      const item = await coreRequest(
        config.url,
        'agent/questions',
        { sessionId: threadId, cwd: target.cwd, question },
        config.token,
      );
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(item));
    })().catch((error: unknown) => {
      const rejected = error instanceof Error && /^core_http_(409|422)$/.test(error.message);
      const status = rejected
        ? Number(error.message.slice(-3))
        : error instanceof SyntaxError
          ? 422
          : 503;
      if (!response.headersSent) {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end('{"error":"connector_unavailable"}');
      }
    });
  });
  server.listen(config.port, '127.0.0.1');
  return {
    server,
    close: async () => {
      stopped = true;
      server.close();
      await loop;
      await Promise.allSettled(tasks);
      for (const prepared of preparedSessions.values()) {
        await prepared.session.close();
      }
    },
  };
}
