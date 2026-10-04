import { readFileSync } from 'node:fs';
import { createAgentConnections, loadDecisionRuntimeConfig } from '../agent-connections/config.js';
import { SessionDecisionGateway } from '../decisions/delivery.js';
import { DecisionService } from '../decisions/service.js';
import { SqliteDecisionRepository } from '../decisions/sqlite-repository.js';

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
  let running: Promise<void> | undefined;
  let stopped = false;

  const tick = () => {
    if (running || stopped) {
      return running;
    }
    running = (async () => {
      for (const item of service.list()) {
        if (stopped) {
          break;
        }
        if (
          item.status === 'queued' ||
          (item.status === 'delivery_failed' && item.deliveryIssue !== 'unsupported')
        ) {
          await service.dispatch(item.id);
        }
      }
    })()
      .catch(() => console.error('Decision delivery worker failed'))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    service,
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
      clearInterval(timer);
      await running;
      repository.close();
    },
  };
}
