import { createHash } from 'node:crypto';
import type { Decision, DecisionAnswer, DecisionCreate } from '@repo/contracts/decisions';
import {
  AgentDeliveryError,
  type AgentGateway,
  type AgentOutcome,
  type DecisionRepository,
} from './ports.js';

export class DecisionConflict extends Error {}

export class DecisionMissing extends Error {}

/** Application policy: independent of HTTP, SQLite, Codex, and the preview's scripted agent. */
export class DecisionService {
  readonly #dispatching = new Set<string>();
  constructor(
    private readonly repository: DecisionRepository,
    private readonly agent: AgentGateway,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Decision[] {
    return this.repository.list();
  }
  get(id: string): Decision {
    const item = this.repository.get(id);
    if (!item) {
      throw new DecisionMissing(id);
    }
    return item;
  }

  async create(
    input: DecisionCreate,
    resolve: (threadId: string) => Promise<Decision['context']>,
  ): Promise<Decision> {
    const id = `dr-${createHash('sha256')
      .update(JSON.stringify([input.threadId, input.key]))
      .digest('hex')
      .slice(0, 32)}`;
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const existing = () => {
      if (this.repository.creationHash(id) !== hash) {
        throw new DecisionConflict('idempotency_key_reused');
      }
      return this.get(id);
    };

    if (this.repository.get(id)) {
      return existing();
    }
    const context = await resolve(input.threadId);
    const { key: _key, threadId: _threadId, ...content } = input;
    const at = this.now();
    const item: Decision = {
      ...content,
      id,
      context,
      revision: 0,
      status: 'awaiting_answer',
      snoozedUntil: null,
      createdAt: at,
      updatedAt: at,
      answers: [],
      events: [{ id: `${id}:opened`, kind: 'opened', at, text: '' }],
    };
    return this.repository.create(item, hash) ? item : existing();
  }

  answer(id: string, input: DecisionAnswer): Decision {
    const item = this.get(id);
    const previous = item.answers.find((answer) => answer.id === input.id);
    if (previous) {
      if (
        previous.text !== input.text ||
        previous.intent !== input.intent ||
        previous.optionId !== input.optionId ||
        previous.expectedRevision !== input.expectedRevision
      ) {
        throw new DecisionConflict('idempotency_key_reused');
      }
      return item;
    }
    if (item.revision !== input.expectedRevision || item.status !== 'awaiting_answer') {
      throw new DecisionConflict('decision_changed');
    }
    if (input.optionId && !item.options.some((option) => option.id === input.optionId)) {
      throw new DecisionConflict('unknown_option');
    }
    if (input.intent === 'research' && input.optionId) {
      throw new DecisionConflict('research_is_not_a_decision');
    }
    const answer = { ...input, at: this.now() };
    const option = item.options.find((candidate) => candidate.id === input.optionId);
    const text = [option?.label, input.text].filter(Boolean).join(' — ');
    return this.update(
      { ...item, answers: [...item.answers, answer], status: 'queued', snoozedUntil: null },
      'answered',
      text,
    );
  }

  retry(id: string, expectedRevision: number): Decision {
    const item = this.get(id);
    if (item.revision !== expectedRevision || item.status !== 'delivery_failed') {
      throw new DecisionConflict('decision_changed');
    }
    return this.update({ ...item, status: 'queued' }, 'retry', '');
  }

  snooze(id: string, expectedRevision: number, deferred: boolean): Decision {
    const item = this.get(id);
    if (item.revision !== expectedRevision || item.status !== 'awaiting_answer') {
      throw new DecisionConflict('decision_changed');
    }
    const snoozedUntil = deferred
      ? new Date(Date.parse(this.now()) + 60 * 60 * 1000).toISOString()
      : null;
    return this.update({ ...item, snoozedUntil }, deferred ? 'snoozed' : 'woken', '');
  }

  /** A worker calls this after answers have been persisted; requests never hold an HTTP connection open. */
  async dispatch(id: string): Promise<void> {
    if (this.#dispatching.has(id)) {
      return;
    }
    this.#dispatching.add(id);
    try {
      let item = this.get(id);
      if (item.status !== 'queued') {
        return;
      }
      const answer = item.answers.at(-1);
      if (!answer) {
        throw new Error('queued decision has no answer');
      }
      try {
        const target = await this.agent.inspect(item.context);
        if (target !== 'ready') {
          throw new AgentDeliveryError(target);
        }
        await this.agent.deliver({
          id: `${item.id}:${answer.id}`,
          decisionId: item.id,
          context: item.context,
          mode: item.mode,
          question: item.question,
          constraints: item.constraints.length
            ? item.constraints
            : item.facts.map((fact) => fact.detail),
          assumption: item.assumption,
          answer,
          selectedOption: item.options.find((option) => option.id === answer.optionId),
        });
        item = this.get(id);
        if (item.status === 'queued' && item.answers.at(-1)?.id === answer.id) {
          this.update({ ...item, status: 'delivered' }, 'delivered', '');
        }
      } catch (error) {
        item = this.get(id);
        if (item.status !== 'queued' || item.answers.at(-1)?.id !== answer.id) {
          return;
        }
        const status =
          error instanceof AgentDeliveryError && error.reason === 'superseded'
            ? 'superseded'
            : 'delivery_failed';
        this.update({ ...item, status }, status, '');
      }
    } finally {
      this.#dispatching.delete(id);
    }
  }

  recordOutcome(outcome: AgentOutcome): Decision {
    const item = this.get(outcome.decisionId);
    if (item.events.some((event) => event.id === outcome.id)) {
      return item;
    }
    if (
      item.answers.at(-1)?.id !== outcome.answerId ||
      item.context.taskRevision !== outcome.taskRevision ||
      !['delivered', 'investigating'].includes(item.status)
    ) {
      throw new DecisionConflict('stale_agent_outcome');
    }
    if (item.status === 'investigating' && outcome.kind === 'investigating') {
      return item;
    }
    // An investigation request cannot silently become authority to implement a policy.
    if (item.answers.at(-1)?.intent === 'research' && outcome.kind === 'applied') {
      throw new DecisionConflict('research_is_not_approval');
    }
    return this.update(
      {
        ...item,
        snoozedUntil: null,
        status: outcome.kind === 'needs_input' ? 'awaiting_answer' : outcome.kind,
      },
      outcome.kind,
      outcome.text,
      outcome.id,
    );
  }

  private update(
    item: Decision,
    kind: Decision['events'][number]['kind'],
    text: string,
    eventId?: string,
  ): Decision {
    const previousRevision = item.revision;
    const at = this.now();
    const next: Decision = {
      ...item,
      revision: previousRevision + 1,
      updatedAt: at,
      events: [
        ...item.events,
        { id: eventId ?? `${item.id}:${previousRevision + 1}`, kind, at, text },
      ],
    };
    if (!this.repository.replace(next, previousRevision)) {
      throw new DecisionConflict('decision_changed');
    }
    return next;
  }
}
