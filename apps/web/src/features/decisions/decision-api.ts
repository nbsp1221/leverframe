import {
  type Decision,
  type DecisionAnswer,
  decisionListSchema,
  decisionSchema,
} from '@repo/contracts/decisions';

export class DecisionApiError extends Error {
  constructor(readonly status: number) {
    super(`Decision API returned ${status}`);
  }
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/v1/decisions${path}`, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    throw new DecisionApiError(response.status);
  }
  return response.json() as Promise<unknown>;
}

export async function loadDecisions(): Promise<Decision[]> {
  return decisionListSchema.parse(await request('')).items;
}

export async function answerDecision(id: string, answer: DecisionAnswer): Promise<Decision> {
  return decisionSchema.parse(await request(`/${encodeURIComponent(id)}/answers`, answer));
}

export async function retryDecision(id: string, expectedRevision: number): Promise<Decision> {
  return decisionSchema.parse(
    await request(`/${encodeURIComponent(id)}/retry`, { expectedRevision }),
  );
}

export async function snoozeDecision(
  id: string,
  expectedRevision: number,
  deferred: boolean,
): Promise<Decision> {
  return decisionSchema.parse(
    await request(`/${encodeURIComponent(id)}/snooze`, { expectedRevision, deferred }),
  );
}
