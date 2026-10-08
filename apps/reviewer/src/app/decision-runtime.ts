import { readFileSync } from 'node:fs';
import { createAgentConnections, loadDecisionRuntimeConfig } from '../agent-connections/config.js';
import { ConnectorRuntime } from '../connectors/runtime.js';
import { ConnectorStore } from '../connectors/store.js';
import { SessionDecisionGateway } from '../decisions/delivery.js';
import { DecisionService } from '../decisions/service.js';
import { SqliteDecisionRepository } from '../decisions/sqlite-repository.js';
import { DecisionDeliveryWorker } from '../decisions/worker.js';

/** Real composition root: no fixtures and no synthetic agent outcomes. */
export function createDecisionRuntime(configPath: string) {
  const config = loadDecisionRuntimeConfig(configPath);
  const token = readFileSync(config.tokenFile, 'utf8').trim();
  if (token.length < 32) {
    throw new Error('decision_token_too_short');
  }
  const connections = createAgentConnections(config);
  const repository = new SqliteDecisionRepository(config.databasePath, config.legacyConnectionId);
  const gateway = new SessionDecisionGateway(connections, repository, config.legacyConnectionId);
  const service = new DecisionService(repository, gateway);
  const connectors = new ConnectorRuntime(new ConnectorStore(config.databasePath), connections);
  let stopped = false;
  const worker = new DecisionDeliveryWorker(
    service,
    (item) => {
      const id = item.context.connectionId ?? config.legacyConnectionId;
      return JSON.stringify([connections.get(id)?.id ?? id, item.context.threadId]);
    },
    (item) => {
      const id = item.context.connectionId ?? config.legacyConnectionId;
      const canonical = connections.get(id)?.id ?? id;
      if (canonical.startsWith('connector-')) {
        connectors.store.recordDelivery(canonical);
      }
    },
  );

  const tick = () => worker.tick().catch(() => console.error('Decision delivery worker failed'));

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    service,
    connectors,
    registration: {
      token,
      resolve: (sessionId: string, connectionId?: string) =>
        gateway.resolve(sessionId, connectionId),
    },
    tick,
    start: () => {
      if (!timer && !stopped) {
        timer = setInterval(() => {
          void tick();
        }, 1_000);
      }
    },
    close: async () => {
      stopped = true;
      connectors.stop();
      clearInterval(timer);
      await worker.close();
      repository.close();
      connectors.store.close();
    },
  };
}
