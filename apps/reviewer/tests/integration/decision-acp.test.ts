import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSideConnection, type AnyMessage } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AcpSessionChannel } from '../../src/agent-connections/acp-channel.js';
import { decisionRuntimeConfigSchema } from '../../src/agent-connections/config.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});
const agentPath = fileURLToPath(new URL('../fixtures/acp/agent.mjs', import.meta.url));

const channel = (env: Record<string, string> = {}) =>
  new AcpSessionChannel(
    { kind: 'stdio', command: process.execPath, args: [agentPath], env },
    2_000,
  );

describe('official ACP SDK transports', () => {
  it('initializes and loads an existing session over stdio, and closes its process', async () => {
    const session = await channel().prepare('existing', '/test');
    try {
      await session.send('response');
    } finally {
      await session.close();
    }
  });
  it('rejects unsupported load and never silently creates another session', async () => {
    await expect(channel({ ACP_NO_LOAD: '1' }).prepare('existing', '/test')).rejects.toThrow(
      'acp_load_session_required',
    );
    await expect(channel().prepare('unknown', '/test')).rejects.toThrow();
  });
  it('reports a dropped transport instead of claiming acceptance', async () => {
    const session = await channel({ ACP_DROP: '1' }).prepare('existing', '/test');
    try {
      await expect(session.send('response')).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
  it('uses the SDK WebSocket transport with bearer auth and the same session contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-acp-ws-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'local-test-token');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => {
      for (const socket of server.clients) {
        socket.terminate();
      }
      server.close();
    });
    let authorization: string | undefined;
    let received = '';
    server.on('connection', (socket, request) => {
      authorization = request.headers.authorization;
      const readable = new ReadableStream<AnyMessage>({
        start(controller) {
          socket.on('message', (data) =>
            controller.enqueue(
              JSON.parse(
                Buffer.concat(
                  Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)],
                ).toString('utf8'),
              ) as AnyMessage,
            ),
          );
          socket.on('close', () => controller.close());
        },
      });
      const writable = new WritableStream<AnyMessage>({
        write(message) {
          socket.send(JSON.stringify(message));
        },
      });
      new AgentSideConnection(
        () => ({
          initialize: () =>
            Promise.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
          authenticate: () => Promise.resolve({}),
          newSession: () => Promise.reject(new Error('must load')),
          loadSession: ({ sessionId }) => {
            expect(sessionId).toBe('existing');
            return Promise.resolve({});
          },
          prompt: ({ prompt }) => {
            received = JSON.stringify(prompt);
            return Promise.resolve({ stopReason: 'end_turn' });
          },
          cancel: () => Promise.resolve(),
        }),
        { readable, writable },
      );
    });
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    const session = await new AcpSessionChannel({
      kind: 'websocket',
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      tokenFile,
    }).prepare('existing', '/test');
    try {
      await session.send('scoped response');
    } finally {
      await session.close();
    }
    expect(authorization).toBe('Bearer local-test-token');
    expect(received).toContain('scoped response');
  });
  it('rejects insecure remote endpoints and duplicate connection identities', () => {
    const config = {
      version: 1,
      databasePath: '/private/inbox',
      tokenFile: '/private/token',
      legacyConnectionId: 'one',
      connections: [
        {
          id: 'one',
          agentId: 'codex',
          sessions: { session: '/test' },
          observer: { kind: 'codex-desktop', socketPath: '/private/socket' },
          transport: { kind: 'websocket', url: 'ws://remote.example/acp' },
        },
      ],
    };
    expect(decisionRuntimeConfigSchema.safeParse(config).success).toBe(false);
    config.connections[0]!.transport.url = 'ws://127.0.0.1:18781/acp/ws';
    expect(decisionRuntimeConfigSchema.safeParse(config).success).toBe(true);
    config.connections.push(config.connections[0]!);
    expect(decisionRuntimeConfigSchema.safeParse(config).success).toBe(false);
  });
});
