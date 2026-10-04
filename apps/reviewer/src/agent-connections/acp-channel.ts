import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, type Stream, ndJsonStream } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import WebSocket from 'ws';
import type { PreparedSession, SessionChannel } from './ports.js';
import { UnsupportedSessionChannel } from './ports.js';

export type AcpTransport =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'websocket'; url: string; tokenFile?: string | undefined };

/** ACP owns framing and negotiation; transports never know about decisions. */
export class AcpSessionChannel implements SessionChannel {
  constructor(
    private readonly transport: AcpTransport,
    private readonly timeoutMs = 60_000,
  ) {}

  async prepare(sessionId: string, cwd: string): Promise<PreparedSession> {
    let stream: Stream;
    let dispose: () => void;
    if (this.transport.kind === 'stdio') {
      const child = spawn(this.transport.command, this.transport.args, {
        env: { ...process.env, ...this.transport.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      // Drain adapter diagnostics, but never log conversation data or credentials.
      child.stderr.resume();
      child.on('error', () => child.stdout.destroy());
      stream = ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      dispose = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (child.pid) {
          try {
            if (process.platform !== 'win32') {
              process.kill(-child.pid, 'SIGTERM');
            } else {
              child.kill();
            }
          } catch {
            /* Already exited. */
          }
        }
      };
    } else {
      const sockets: WebSocket[] = [];

      class OwnedWebSocket extends WebSocket {
        constructor(
          url: string,
          protocols?: string | string[],
          options?: { headers?: Record<string, string> },
        ) {
          super(url, protocols, { ...options, maxPayload: 32 * 1024 * 1024 });
          sockets.push(this);
        }
      }

      const token = this.transport.tokenFile
        ? readFileSync(this.transport.tokenFile, 'utf8').trim()
        : undefined;
      stream = createWebSocketStream(this.transport.url, {
        WebSocket: OwnedWebSocket,
        cookies: 'omit',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      dispose = () => {
        for (const socket of sockets) {
          socket.terminate();
        }
      };
    }
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      }),
      stream,
    );

    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('acp_timeout')), this.timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const hello = await bounded(
        client.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'leverframe', version: '1' },
        }),
      );
      if (hello.protocolVersion !== 1 || !hello.agentCapabilities?.loadSession) {
        throw new UnsupportedSessionChannel('acp_load_session_required');
      }
      await bounded(client.loadSession({ sessionId, cwd, mcpServers: [] }));
      return {
        send: async (text) => {
          await bounded(client.prompt({ sessionId, prompt: [{ type: 'text', text }] }));
        },
        close: () => {
          dispose();
          return Promise.resolve();
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }
}
