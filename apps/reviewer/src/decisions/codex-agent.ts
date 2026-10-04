import { createHash } from 'node:crypto';
import type { Decision } from '@repo/contracts/decisions';
import { z } from 'zod';
import type { CodexRpc } from './codex-rpc.js';
import { AgentDeliveryError, type AgentGateway, type AnswerDelivery } from './ports.js';
import { DecisionConflict } from './service.js';

const threadResult = z.object({
  thread: z.object({
    id: z.string(),
    cwd: z.string(),
    canAcceptDirectInput: z.boolean().optional(),
    turns: z.array(
      z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()).default([]) }),
    ),
  }),
});

type Thread = z.infer<typeof threadResult>['thread'];

export interface DeliveryJournal {
  reserveDelivery(id: string, hash: string): boolean;
}

export function answerMessage(delivery: AnswerDelivery): string {
  return `Leverframe decision response [${delivery.id}]\nThe following JSON contains the user's response to your saved request. Use only its stated scope. Research is not approval. Do not repost the same question. Report what you understood; do not claim work is applied merely because this message arrived.\n${JSON.stringify(
    {
      decisionId: delivery.decisionId,
      question: delivery.question,
      constraints: delivery.constraints,
      assumption: delivery.assumption,
      intent: delivery.answer.intent,
      option: delivery.selectedOption ?? null,
      text: delivery.answer.text,
    },
  )}`;
}

export class CodexDecisionAgent implements AgentGateway {
  constructor(
    private readonly rpc: CodexRpc,
    private readonly journal: DeliveryJournal,
    private readonly allowedThreads: ReadonlyMap<string, string>,
  ) {}

  private async read(threadId: string): Promise<Thread> {
    const cwd = this.allowedThreads.get(threadId);
    if (!cwd) {
      throw new DecisionConflict('thread_not_allowed');
    }
    const result = threadResult.parse(
      await this.rpc.call('thread/read', { threadId, includeTurns: true }),
    );
    if (result.thread.id !== threadId || result.thread.cwd !== cwd) {
      throw new DecisionConflict('thread_identity_changed');
    }
    return result.thread;
  }

  async resolve(threadId: string): Promise<Decision['context']> {
    const thread = await this.read(threadId);
    const last = thread.turns.at(-1);
    if (!last) {
      throw new DecisionConflict('thread_has_no_turn');
    }
    return { agentId: 'codex', threadId, taskId: last.id, taskRevision: last.id };
  }

  async inspect(context: Decision['context']): Promise<'ready' | 'offline' | 'superseded'> {
    try {
      await this.read(context.threadId);
      return 'ready';
    } catch (error) {
      return error instanceof DecisionConflict ? 'superseded' : 'offline';
    }
  }

  async deliver(delivery: AnswerDelivery): Promise<void> {
    const thread = await this.read(delivery.context.threadId);
    const message = answerMessage(delivery);
    // Exact user-message receipt is checked before stale-turn checks: delivery itself creates a new turn.
    const received = thread.turns.filter((turn) =>
      turn.items.some((item) => {
        const parsed = z
          .object({
            type: z.literal('userMessage'),
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
          })
          .safeParse(item);
        return (
          parsed.success &&
          parsed.data.content.some((part) => part.type === 'text' && part.text === message)
        );
      }),
    );
    if (received.length === 1) {
      return;
    }
    if (received.length > 1) {
      throw new Error('multiple_delivery_receipts');
    }
    const last = thread.turns.at(-1);
    if (last?.id !== delivery.context.taskRevision) {
      throw new AgentDeliveryError('superseded');
    }
    if (last.status === 'inProgress' || thread.canAcceptDirectInput !== true) {
      throw new AgentDeliveryError('offline');
    }
    const loaded = z
      .object({ data: z.array(z.string()) })
      .parse(await this.rpc.call('thread/loaded/list', {}));
    if (!loaded.data.includes(thread.id)) {
      throw new AgentDeliveryError('offline');
    }
    const hash = createHash('sha256').update(message).digest('hex');
    if (!this.journal.reserveDelivery(delivery.id, hash)) {
      throw new Error('delivery_unconfirmed');
    }
    // Never blindly repeat turn/start after an uncertain response, including after a service restart.
    const result = await this.rpc.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: message }],
    });
    z.object({ turn: z.object({ id: z.string().min(1) }) }).parse(result);
  }
}
