import WebSocket from 'ws';

export interface CodexRpc {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Connects to the existing Codex app-server; never starts or takes over a Codex runtime. */
export class CodexObserverRpc implements CodexRpc {
  constructor(private readonly socketPath: string) {}
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!['thread/read', 'thread/loaded/list'].includes(method)) {
      throw new Error('observer_is_read_only');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, {
        maxPayload: 32 * 1024 * 1024,
      });
      const timer = setTimeout(() => finish(new Error('codex_rpc_timeout')), 15_000);

      const finish = (error?: Error, result?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('message');
        socket.terminate();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      socket.on('error', () => finish(new Error('codex_rpc_unavailable')));
      socket.on('close', () => {
        clearTimeout(timer);
        reject(new Error('codex_rpc_closed'));
      });
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: { name: 'leverframe', version: '0.1.0' },
              capabilities: { experimentalApi: true },
            },
          }),
        ),
      );
      socket.on('message', (bytes) => {
        try {
          const buffer = Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes as ArrayBuffer);
          const value = JSON.parse(buffer.toString('utf8')) as {
            id?: number;
            error?: unknown;
            result?: unknown;
          };
          if (value.id !== 1 && value.id !== 2) {
            return;
          }
          if (value.error) {
            finish(new Error('codex_rpc_rejected'));
            return;
          }
          if (value.id === 1) {
            socket.send(JSON.stringify({ method: 'initialized' }));
            socket.send(JSON.stringify({ id: 2, method, params }));
          } else {
            finish(undefined, value.result);
          }
        } catch {
          finish(new Error('codex_rpc_invalid_response'));
        }
      });
    });
  }
}
