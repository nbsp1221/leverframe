import {
  type DevelopmentRepository,
  type DevelopmentRunDetail,
  type DevelopmentRunSummary,
  type DevelopmentTicket,
  developmentRepositoryListSchema,
  developmentRunDetailSchema,
  developmentRunListSchema,
  developmentTicketListSchema,
} from '@repo/contracts';

export type DevelopmentDataResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'missing-config' | 'config-error' | 'network-error' | 'schema-error' }
  | { kind: 'http-error'; status: number };

function reviewerBase(): URL | undefined {
  const configured = process.env.REVIEWER_INTERNAL_URL;
  if (!configured) {
    return undefined;
  }
  try {
    const base = new URL(`${configured.replace(/\/+$/, '')}/`);
    return ['http:', 'https:'].includes(base.protocol) ? base : undefined;
  } catch {
    return undefined;
  }
}

export async function getDevelopmentRuns(): Promise<
  DevelopmentDataResult<DevelopmentRunSummary[]>
> {
  const base = reviewerBase();
  if (base === undefined) {
    return { kind: 'missing-config' };
  }
  try {
    const response = await fetch(new URL('api/v1/development/runs', base), { cache: 'no-store' });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = developmentRunListSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data.items } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

export async function getDevelopmentRepositories(): Promise<
  DevelopmentDataResult<DevelopmentRepository[]>
> {
  const base = reviewerBase();
  if (base === undefined) {
    return { kind: 'missing-config' };
  }
  try {
    const url = new URL('api/v1/development/repositories', base);
    url.searchParams.set('per_page', '100');
    const response = await fetch(url, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = developmentRepositoryListSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data.items } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

export async function getDevelopmentTickets(): Promise<DevelopmentDataResult<DevelopmentTicket[]>> {
  const base = reviewerBase();
  if (base === undefined) {
    return { kind: 'missing-config' };
  }
  try {
    const response = await fetch(new URL('api/v1/development/tickets', base), {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = developmentTicketListSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data.items } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

export async function getDevelopmentRun(
  runId: number,
): Promise<DevelopmentDataResult<DevelopmentRunDetail>> {
  const base = reviewerBase();
  if (base === undefined) {
    return { kind: 'missing-config' };
  }
  try {
    const response = await fetch(new URL(`api/v1/development/runs/${runId}`, base), {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = developmentRunDetailSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}
