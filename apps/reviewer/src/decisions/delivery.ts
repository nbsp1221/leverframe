import { createHash } from 'node:crypto';
import type { Decision } from '@repo/contracts/decisions';
import type { AgentConnection, SessionSnapshot } from '../agent-connections/ports.js';
import { UnsupportedSessionChannel } from '../agent-connections/ports.js';
import {
  AgentDeliveryError,
  type AgentGateway,
  type AnswerDelivery,
  type DeliveryJournal,
} from './ports.js';
import { DecisionConflict } from './service.js';

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

/** Application delivery policy; knows no RPC method, socket, SDK or provider-specific turn shape. */
export class SessionDecisionGateway implements AgentGateway {
  constructor(
    private readonly connections: ReadonlyMap<string, AgentConnection>,
    private readonly journal: DeliveryJournal,
    private readonly legacyConnectionId: string,
  ) {}

  private target(context: Decision['context']): AgentConnection {
    const connection = this.connections.get(context.connectionId ?? this.legacyConnectionId);
    if (!connection || !connection.sessions.has(context.threadId)) {
      throw new DecisionConflict('session_not_allowed');
    }
    return connection;
  }

  async resolve(
    sessionId: string,
    connectionId = this.legacyConnectionId,
  ): Promise<Decision['context']> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.sessions.has(sessionId)) {
      throw new DecisionConflict('session_not_allowed');
    }
    const snapshot = await connection.observer.read(sessionId);
    if (!snapshot.revision || snapshot.state === 'cancelled') {
      throw new DecisionConflict('session_not_available');
    }
    return {
      connectionId,
      agentId: connection.agentId,
      threadId: sessionId,
      taskId: snapshot.revision,
      taskRevision: snapshot.revision,
    };
  }

  inspect(context: Decision['context']): Promise<'ready' | 'superseded'> {
    try {
      this.target(context);
      return Promise.resolve('ready');
    } catch {
      return Promise.resolve('superseded');
    }
  }

  private receipt(snapshot: SessionSnapshot, message: string): boolean {
    const count = snapshot.messages.filter((value) => value === message).length;
    if (count > 1) {
      throw new AgentDeliveryError('unconfirmed');
    }
    return count === 1;
  }

  private assertReady(snapshot: SessionSnapshot, revision: string): void {
    if (snapshot.revision !== revision || snapshot.state === 'cancelled') {
      throw new AgentDeliveryError('superseded');
    }
    if (snapshot.state !== 'ready') {
      throw new AgentDeliveryError(snapshot.state === 'busy' ? 'busy' : 'offline');
    }
  }

  async deliver(delivery: AnswerDelivery): Promise<void> {
    const connection = this.target(delivery.context);
    if (this.journal.deliveryConfirmed(delivery.id)) {
      return;
    }
    const sessionId = delivery.context.threadId;
    const key = JSON.stringify([connection.id, sessionId]);
    if (!this.journal.acquireSession(key, delivery.id)) {
      throw new AgentDeliveryError('busy');
    }
    let reserved = this.journal.deliveryReserved(delivery.id);
    const message = answerMessage(delivery);

    const confirmed = () => {
      this.journal.confirmDelivery(delivery.id);
      this.journal.releaseSession(key, delivery.id);
    };

    try {
      const before = await connection.observer.read(sessionId);
      if (this.receipt(before, message)) {
        confirmed();
        return;
      }
      if (reserved) {
        throw new AgentDeliveryError('unconfirmed');
      }
      this.assertReady(before, delivery.context.taskRevision);
      const prepared = await connection.channel.prepare(
        sessionId,
        connection.sessions.get(sessionId)!,
        delivery.context.taskRevision,
      );
      try {
        // Loading an adapter can take time. Recheck the actual target immediately before send.
        const current = await connection.observer.read(sessionId);
        if (this.receipt(current, message)) {
          confirmed();
          return;
        }
        this.assertReady(current, delivery.context.taskRevision);
        const hash = createHash('sha256').update(message).digest('hex');
        reserved = true;
        if (!this.journal.reserveDelivery(delivery.id, hash)) {
          throw new AgentDeliveryError('unconfirmed');
        }
        try {
          await prepared.send(message);
        } catch {
          throw new AgentDeliveryError('unconfirmed');
        }
        if (!this.receipt(await connection.observer.read(sessionId), message)) {
          throw new AgentDeliveryError('unconfirmed');
        }
        confirmed();
      } finally {
        await prepared.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof UnsupportedSessionChannel) {
        throw new AgentDeliveryError('unsupported');
      }
      if (reserved && !(error instanceof AgentDeliveryError)) {
        throw new AgentDeliveryError('unconfirmed');
      }
      throw error;
    } finally {
      if (!reserved) {
        this.journal.releaseSession(key, delivery.id);
      }
    }
  }
}
