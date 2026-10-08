import type { Decision } from '@repo/contracts/decisions';

export interface DecisionRepository {
  list(): Decision[];
  get(id: string): Decision | undefined;
  insert(decision: Decision): void;
  creationHash(id: string): string | undefined;
  create(decision: Decision, hash: string): boolean;
  replace(decision: Decision, expectedRevision: number): boolean;
}

/** Persistent outbox: reservation is never reset after an uncertain network call. */
export interface DeliveryJournal {
  deliveryReserved(id: string): boolean;
  reserveDelivery(id: string, hash: string): boolean;
  confirmDelivery(id: string): void;
  deliveryConfirmed(id: string): boolean;
  acquireSession(key: string, deliveryId: string): boolean;
  releaseSession(key: string, deliveryId: string): void;
}

export type DeliveryIssue = 'offline' | 'busy' | 'unsupported' | 'unconfirmed';

export interface AnswerDelivery {
  /** Stable across retries. Adapters must reconcile uncertain delivery before sending again. */
  id: string;
  decisionId: string;
  context: Decision['context'];
  mode: Decision['mode'];
  question: string;
  constraints: string[];
  assumption: string | null;
  answer: Decision['answers'][number];
  selectedOption: Decision['options'][number] | undefined;
}

export interface AgentOutcome {
  id: string;
  decisionId: string;
  answerId: string;
  taskRevision: string;
  kind: 'investigating' | 'needs_input' | 'applied';
  text: string;
}

export interface AgentGateway {
  /** Check the original target before delivery. Never infer authority from silence. */
  inspect(context: Decision['context']): Promise<'ready' | 'offline' | 'superseded'>;
  /** Accept into the target conversation, not "apply the decision". Check identity and readiness again at send time. */
  deliver(delivery: AnswerDelivery): Promise<void>;
}

export class AgentDeliveryError extends Error {
  constructor(readonly reason: DeliveryIssue | 'superseded') {
    super(reason);
  }
}
