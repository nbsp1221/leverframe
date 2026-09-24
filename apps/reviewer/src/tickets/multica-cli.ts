import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  TicketAdapter,
  TicketProjectionStatus,
  TicketSnapshot,
  TicketSummary,
} from './adapter.js';

const execFileAsync = promisify(execFile);
const issueSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  status: z.string().min(1),
  priority: z.string().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
});
const issueListSchema = z.object({ issues: z.array(issueSchema) });
const resourceListSchema = z.array(
  z.object({
    resource_type: z.string(),
    resource_ref: z.object({ url: z.string().url() }).passthrough(),
  }),
);

type CommandRunner = (args: readonly string[]) => Promise<string>;

export class MulticaCliTicketAdapter implements TicketAdapter {
  readonly #run: CommandRunner;

  constructor(input: { cliPath: string; run?: CommandRunner }) {
    this.#run = input.run ?? createRunner(input.cliPath);
  }

  async listTickets(input: { limit: number; offset: number }): Promise<readonly TicketSummary[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('ticket list limit must be between 1 and 100');
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new Error('ticket list offset must be non-negative');
    }
    const result = issueListSchema.parse(
      JSON.parse(
        await this.#run([
          'issue',
          'list',
          '--limit',
          String(input.limit),
          '--offset',
          String(input.offset),
          '--output',
          'json',
        ]),
      ),
    );
    return result.issues.map(summary);
  }

  async getTicket(id: string): Promise<TicketSnapshot> {
    const issue = issueSchema.parse(
      JSON.parse(await this.#run(['issue', 'get', id, '--output', 'json'])),
    );
    const repositorySuggestions =
      issue.project_id === null || issue.project_id === undefined
        ? []
        : repositoriesFromResources(
            JSON.parse(
              await this.#run([
                'project',
                'resource',
                'list',
                issue.project_id,
                '--output',
                'json',
              ]),
            ),
          );
    return {
      ...summary(issue),
      description: issue.description,
      repositorySuggestions,
      url: null,
    };
  }

  async projectStatus(id: string, status: TicketProjectionStatus): Promise<void> {
    await this.#run([
      'issue',
      'metadata',
      'set',
      id,
      '--key',
      'leverframe_status',
      '--value',
      status,
      '--type',
      'string',
    ]);
  }
}

function createRunner(cliPath: string): CommandRunner {
  return async (args) => {
    const result = await execFileAsync(cliPath, [...args], {
      encoding: 'utf8',
      maxBuffer: 1_000_000,
      timeout: 15_000,
    });
    return result.stdout;
  };
}

function summary(issue: z.infer<typeof issueSchema>): TicketSummary {
  return {
    id: issue.id,
    key: issue.identifier,
    priority: issue.priority ?? null,
    projectId: issue.project_id ?? null,
    status: issue.status,
    title: issue.title,
  };
}

function repositoriesFromResources(value: unknown): string[] {
  const resources = resourceListSchema.parse(value);
  return [
    ...new Set(
      resources
        .filter((resource) => resource.resource_type === 'github_repo')
        .map((resource) => repositoryFromUrl(resource.resource_ref.url))
        .filter((repository): repository is string => repository !== undefined),
    ),
  ];
}

function repositoryFromUrl(value: string): string | undefined {
  const url = new URL(value);
  if (url.hostname !== 'github.com') {
    return undefined;
  }
  const parts = url.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : undefined;
}
