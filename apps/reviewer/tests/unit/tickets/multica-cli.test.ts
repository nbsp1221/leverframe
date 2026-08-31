import { describe, expect, it, vi } from 'vitest';
import { MulticaCliTicketAdapter } from '../../../src/tickets/multica-cli.js';

const issue = {
  id: '1e9eb5d7-496f-4d9a-8a7d-0f31a7724502',
  identifier: 'PER-59',
  title: 'Build the graph',
  description: 'Acceptance context',
  status: 'in_progress',
  priority: 'high',
  project_id: '0d5d20d6-dcda-4fdc-98e8-0edcab345486',
};

describe('Multica CLI ticket adapter', () => {
  it('maps a bounded issue list without exposing Multica response types', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ issues: [issue] }));
    const adapter = new MulticaCliTicketAdapter({ cliPath: '/unused', run });

    await expect(adapter.listTickets({ limit: 20, offset: 0 })).resolves.toEqual([
      {
        id: issue.id,
        key: 'PER-59',
        priority: 'high',
        projectId: issue.project_id,
        status: 'in_progress',
        title: 'Build the graph',
      },
    ]);
    expect(run).toHaveBeenCalledWith([
      'issue',
      'list',
      '--limit',
      '20',
      '--offset',
      '0',
      '--output',
      'json',
    ]);
  });

  it('imports every GitHub project resource without choosing by position', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(issue))
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            resource_type: 'github_repo',
            resource_ref: { url: 'https://github.com/nbsp1221/leverframe.git' },
          },
          {
            resource_type: 'github_repo',
            resource_ref: { url: 'https://github.com/nbsp1221/skillpin-private-e2e-20260718' },
          },
          { resource_type: 'url', resource_ref: { url: 'https://example.com' } },
        ]),
      );
    const adapter = new MulticaCliTicketAdapter({ cliPath: '/unused', run });

    await expect(adapter.getTicket('PER-59')).resolves.toMatchObject({
      key: 'PER-59',
      description: 'Acceptance context',
      repositorySuggestions: ['nbsp1221/leverframe', 'nbsp1221/skillpin-private-e2e-20260718'],
    });
  });

  it('imports a ticket without a project without requesting resources', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ ...issue, project_id: null }));
    const adapter = new MulticaCliTicketAdapter({ cliPath: '/unused', run });

    await expect(adapter.getTicket('PER-59')).resolves.toMatchObject({
      repositorySuggestions: [],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects unbounded list requests before invoking the CLI', async () => {
    const run = vi.fn();
    const adapter = new MulticaCliTicketAdapter({ cliPath: '/unused', run });

    await expect(adapter.listTickets({ limit: 101, offset: 0 })).rejects.toThrow(
      'ticket list limit must be between 1 and 100',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('projects only a bounded status metadata value without agent side effects', async () => {
    const run = vi.fn().mockResolvedValue('{}');
    const adapter = new MulticaCliTicketAdapter({ cliPath: '/unused', run });

    await adapter.projectStatus(issue.id, 'waiting_for_operator');

    expect(run).toHaveBeenCalledWith([
      'issue',
      'metadata',
      'set',
      issue.id,
      '--key',
      'leverframe_status',
      '--value',
      'waiting_for_operator',
      '--type',
      'string',
    ]);
  });
});
