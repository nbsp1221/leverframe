import type { Decision } from '@repo/contracts/decisions';

export interface DecisionRepository {
  list(): Decision[];
  get(id: string): Decision | undefined;
  insert(decision: Decision): void;
  creationHash(id: string): string | undefined;
  create(decision: Decision, hash: string): boolean;
  replace(decision: Decision, expectedRevision: number): boolean;
}

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
  /** Check cancellation and scope changes before delivery. Never infer authority from silence. */
  inspect(context: Decision['context']): Promise<'ready' | 'offline' | 'superseded'>;
  /** Accept into the target conversation, not "apply the decision". Enforce expected task revision again at send time. */
  deliver(delivery: AnswerDelivery): Promise<void>;
}

export class AgentDeliveryError extends Error {
  constructor(readonly reason: 'offline' | 'superseded') {
    super(reason);
  }
}
