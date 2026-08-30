import { describe, expect, it, vi } from 'vitest';
import type { TicketAdapter } from '../../../src/tickets/adapter.js';
import { JobDatabase } from '../../../src/jobs/database.js';
import { TicketProjectionWorker } from '../../../src/tickets/projection-worker.js';

describe('ticket status projection', () => {
  it('persists the intent before projecting and does not duplicate a confirmed status', async () => {
    const database = new JobDatabase(':memory:');
    const run = database.development.createRun({
      repository: 'owner/repo',
      goal: 'Do work',
      checkout: {
        baseSha: 'a'.repeat(40),
        cloneUrl: 'https://github.com/owner/repo.git',
        defaultBranch: 'main',
        installationId: 1,
        repositoryId: 2,
      },
      externalSource: { provider: 'multica', id: 'ticket-id', key: 'PER-59' },
    });
    const projectStatus = vi.fn().mockResolvedValue(undefined);
    const adapter: TicketAdapter = {
      getTicket: vi.fn(),
      listTickets: vi.fn(),
      projectStatus,
    };
    const worker = new TicketProjectionWorker({
      adapter,
      database: database.development,
      projections: database.developmentProjections,
      intervalMs: 5,
    });

    worker.start();
    await vi.waitFor(() => expect(projectStatus).toHaveBeenCalledWith('ticket-id', 'started'));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    await worker.stop();

    expect(projectStatus).toHaveBeenCalledTimes(1);
    expect(database.developmentProjections.getTicketExternalId(run.id, 'multica')).toBe(
      'ticket-id',
    );
    database.close();
  });
});
