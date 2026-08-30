export interface TicketSummary {
  id: string;
  key: string;
  priority: string | null;
  projectId: string | null;
  status: string;
  title: string;
}

export interface TicketSnapshot extends TicketSummary {
  description: string;
  repositorySuggestions: readonly string[];
  url: string | null;
}

export const ticketProjectionStatuses = [
  'started',
  'waiting_for_operator',
  'candidate_verified',
  'pr_linked',
  'completed',
  'failed',
] as const;

export type TicketProjectionStatus = (typeof ticketProjectionStatuses)[number];

export function isTicketProjectionStatus(value: string): value is TicketProjectionStatus {
  return ticketProjectionStatuses.some((status) => status === value);
}

export interface TicketAdapter {
  getTicket(id: string): Promise<TicketSnapshot>;
  listTickets(input: { limit: number; offset: number }): Promise<readonly TicketSummary[]>;
  projectStatus(id: string, status: TicketProjectionStatus): Promise<void>;
}
