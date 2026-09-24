import type { DatabaseSync } from 'node:sqlite';
import type { DevelopmentRun } from './development-repository.js';
import { type DevelopmentRunRow, mapDevelopmentRun } from './development-mappers.js';

export interface DevelopmentPullRequestReference {
  headSha: string;
  number: number;
  state: 'open';
  url: string;
}

export function getPullRequestReference(
  database: DatabaseSync,
  runId: number,
): DevelopmentPullRequestReference | undefined {
  const row = database
    .prepare(`
      SELECT external_id, url, observation_json
      FROM development_external_refs
      WHERE run_id = ? AND provider = 'github' AND kind = 'PULL_REQUEST'
    `)
    .get(runId) as
    | { external_id: string; observation_json: string | null; url: string | null }
    | undefined;
  if (row === undefined || row.url === null || row.observation_json === null) {
    return undefined;
  }
  const observation = parsePullRequestObservation(row.observation_json);
  return {
    headSha: observation.headSha,
    number: Number(row.external_id),
    state: observation.state,
    url: row.url,
  };
}

export function findRunByPullRequest(
  database: DatabaseSync,
  input: { repository: string; pullRequestNumber: number },
): DevelopmentRun | undefined {
  const row = database
    .prepare(`
      SELECT r.*, w.revision, w.goal
      FROM development_runs r
      JOIN development_work_revisions w ON w.id = r.accepted_work_revision_id
      JOIN development_external_refs ref ON ref.run_id = r.id
      WHERE r.repository = ? AND ref.provider = 'github' AND ref.kind = 'PULL_REQUEST'
        AND ref.external_id = ?
      ORDER BY r.id DESC LIMIT 1
    `)
    .get(input.repository, String(input.pullRequestNumber)) as DevelopmentRunRow | undefined;
  return row === undefined ? undefined : mapDevelopmentRun(row);
}

function parsePullRequestObservation(value: string): { headSha: string; state: 'open' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('stored pull request observation is malformed');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { head_sha?: unknown }).head_sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test((parsed as { head_sha: string }).head_sha) ||
    (parsed as { state?: unknown }).state !== 'open'
  ) {
    throw new Error('stored pull request observation is invalid');
  }
  return { headSha: (parsed as { head_sha: string }).head_sha, state: 'open' };
}
