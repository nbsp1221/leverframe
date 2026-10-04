import { CodexDecisionAgent } from '../../src/decisions/codex-agent.js';
import { CodexSocketRpc } from '../../src/decisions/codex-rpc.js';
import { AgentDeliveryError } from '../../src/decisions/ports.js';
import { DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';
import { ScriptedDecisionAgent } from './decision-agent.js';
import { decisionFixtures } from './decisions.js';

export function createDecisionPreview(
  databasePath: string,
  codex?: { socketPath: string; threads: Record<string, string>; token: string },
) {
  const repository = new SqliteDecisionRepository(databasePath);
  for (const fixture of decisionFixtures()) {
    repository.insert(fixture);
  }
  const agent = new ScriptedDecisionAgent();
  const live = codex
    ? new CodexDecisionAgent(
        new CodexSocketRpc(codex.socketPath),
        repository,
        new Map(Object.entries(codex.threads)),
      )
    : undefined;
  const fixtures = new Set(decisionFixtures().map((item) => item.context.threadId));

  const gateway = (context: { agentId: string; threadId: string }) => {
    if (fixtures.has(context.threadId)) {
      return agent;
    }
    if (context.agentId === 'codex' && live) {
      return live;
    }
    throw new AgentDeliveryError('offline');
  };

  const service = new DecisionService(repository, {
    inspect: (context) => gateway(context).inspect(context),
    deliver: (delivery) => gateway(delivery.context).deliver(delivery),
  });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) {
      return;
    }
    busy = true;
    void (async () => {
      for (const item of service.list()) {
        if (item.status === 'queued') {
          await service.dispatch(item.id);
        }
        const outcome = fixtures.has(item.context.threadId)
          ? agent.nextOutcome(service.get(item.id), Date.now())
          : undefined;
        if (outcome) {
          service.recordOutcome(outcome);
        }
      }
    })()
      .catch((error: unknown) => console.error('Decision preview worker failed', error))
      .finally(() => {
        busy = false;
      });
  }, 500);
  return {
    service,
    registration:
      live && codex
        ? { token: codex.token, resolve: (threadId: string) => live.resolve(threadId) }
        : undefined,
    close: () => {
      clearInterval(timer);
      repository.close();
    },
  };
}
