import { setTimeout as sleep } from 'node:timers/promises';
import type { ConnectorCommand } from '@repo/contracts/connectors';
import type { AgentConnection } from '../agent-connections/ports.js';
import { AgentDeliveryError } from '../decisions/ports.js';
import type { ConnectorStore } from './store.js';

/** Core-side adapter: provider/runtime details stay on the connected computer. */
export class ConnectorRuntime {
  private closed = false;
  constructor(
    readonly store: ConnectorStore,
    private readonly connections: Map<string, AgentConnection>,
    private readonly timeouts = { query: 20_000, execution: 80_000 },
  ) {
    for (const item of store.list()) {
      this.attach(item.id);
    }
    for (const alias of store.aliases()) {
      const target = this.connections.get(alias.connector_id);
      if (target) {
        this.connections.set(alias.legacy_id, target);
      }
    }
  }
  attach(id: string) {
    const sessions = this.store.sessions(id);
    this.connections.set(id, {
      id,
      agentId: 'codex',
      sessions,
      observer: {
        read: async (sessionId) => {
          const result = await this.command(id, {
            kind: 'read',
            sessionId,
            cwd: sessions.get(sessionId)!,
          });
          if (!result.snapshot) {
            throw new AgentDeliveryError('offline');
          }
          return result.snapshot;
        },
      },
      channel: {
        prepare: async (sessionId, cwd, revision) => {
          const ready = await this.command(id, { kind: 'prepare', sessionId, cwd });
          if (!ready.preparedId) {
            throw new AgentDeliveryError('offline');
          }
          const preparedId = ready.preparedId;
          return {
            send: async (message) => {
              await this.command(id, {
                kind: 'send',
                sessionId,
                cwd,
                preparedId,
                message,
                revision: revision ?? '',
              });
            },
            close: async () => {
              await this.command(id, { kind: 'close', sessionId, cwd, preparedId });
            },
          };
        },
      },
    });
  }
  bind(id: string, sessionId: string, cwd: string) {
    this.store.bind(id, sessionId, cwd);
    const connection = this.connections.get(id);
    if (!connection) {
      this.attach(id);
    } else {
      (connection.sessions as Map<string, string>).set(sessionId, cwd);
    }
  }
  /** Operator migration: verify originals on the connector before replacing any old route. */
  async adoptLegacy(legacyId: string, id: string, sessions: ReadonlyMap<string, string>) {
    for (const [session, cwd] of sessions) {
      this.bind(id, session, cwd);
      await this.connections.get(id)!.observer.read(session);
    }
    this.store.adoptLegacy(legacyId, id);
    this.connections.set(legacyId, this.connections.get(id)!);
  }
  revoke(id: string) {
    this.store.revoke(id);
    // Keep the route so existing answers remain pending rather than being mislabeled superseded.
  }
  private async command(id: string, command: Omit<ConnectorCommand, 'id'>) {
    if (this.closed || !this.store.active(id)) {
      throw new AgentDeliveryError('offline');
    }
    const timeout =
      command.kind === 'send' || command.kind === 'prepare'
        ? this.timeouts.execution
        : this.timeouts.query;
    const key = this.store.enqueue(id, command, timeout);
    const deadline = Date.now() + timeout;
    try {
      while (!this.closed && Date.now() < deadline) {
        const result = this.store.result(key);
        if (result) {
          if (!result.ok) {
            throw new AgentDeliveryError(result.error);
          }
          return result;
        }
        await sleep(100);
      }
      throw new AgentDeliveryError(command.kind === 'send' ? 'unconfirmed' : 'offline');
    } finally {
      this.store.expire(key);
    }
  }
  stop() {
    this.closed = true;
  }
}
