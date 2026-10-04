import { DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';
import { ScriptedDecisionAgent } from './decision-agent.js';
import { decisionFixtures } from './decisions.js';

export function createDecisionPreview(databasePath: string) {
  const repository = new SqliteDecisionRepository(databasePath);
  for (const fixture of decisionFixtures()) {
    repository.insert(fixture);
  }
  const agent = new ScriptedDecisionAgent();
  const service = new DecisionService(repository, agent);
  const fixtures = new Set(decisionFixtures().map((item) => item.context.threadId));
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
    close: () => {
      clearInterval(timer);
      repository.close();
    },
  };
}
