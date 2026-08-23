import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../../../src/review/result.js';
import { GitHubAppClient } from '../../../src/github/client.js';
import {
  findingPublicationMarker,
  parseFindingPublicationMarker,
  prepareReviewPublication,
} from '../../../src/review/publication.js';

const githubMocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  installationRequest: vi.fn(),
}));

vi.mock('@octokit/app', () => ({
  App: vi.fn(function () {
    return { getInstallationOctokit: githubMocks.getInstallationOctokit };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  githubMocks.getInstallationOctokit.mockResolvedValue({
    request: githubMocks.installationRequest,
  });
});

const result: ReviewResult = {
  findings: [
    {
      confidence: 'high',
      evidence: 'new value is returned',
      explanation: 'the new value breaks callers',
      file: './src/changed.ts',
      line: 7,
      severity: 'high',
      suggested_action: 'return the compatible value',
      title: 'Return contract changed',
    },
    {
      confidence: 'medium',
      evidence: 'line is unchanged',
      explanation: 'this cannot be anchored in the PR diff',
      file: 'src/changed.ts',
      line: 3,
      severity: 'medium',
      suggested_action: 'inspect the changed caller',
      title: 'Unchanged line',
    },
  ],
  limitations: [],
  summary: 'One inline and one summary finding',
  tests_run: [],
};

describe('review publication preparation', () => {
  it('publishes only changed right-side lines inline', () => {
    const publication = prepareReviewPublication(
      result,
      new Map([['src/changed.ts', new Set([7])]]),
      42,
    );

    expect(publication.inlineFindingIndexes).toEqual(new Set([0]));
    expect(publication.inlineComments).toEqual([
      expect.objectContaining({ line: 7, path: 'src/changed.ts' }),
    ]);
    expect(publication.inlineComments[0]?.body).toContain('🟠 **[HIGH] Return contract changed**');
    expect(publication.inlineComments[0]?.body).toContain('<!-- leverframe:finding:');
    expect(parseFindingPublicationMarker(publication.inlineComments[0]?.body ?? '')).toEqual({
      fingerprint: publication.inlineComments[0]?.fingerprint,
      jobId: 42,
    });
  });

  it('parses exactly one trusted finding marker', () => {
    const marker = findingPublicationMarker(7, '0123456789abcdef');

    expect(parseFindingPublicationMarker(`body\n\n${marker}`)).toEqual({
      fingerprint: '0123456789abcdef',
      jobId: 7,
    });
    expect(parseFindingPublicationMarker(`${marker}\n${marker}`)).toBeUndefined();
    expect(
      parseFindingPublicationMarker('<!-- leverframe:finding:invalid:job:7 -->'),
    ).toBeUndefined();
    expect(() => findingPublicationMarker(0, '0123456789abcdef')).toThrow();
  });
});

describe('review publication cancellation', () => {
  it('does not POST when cancellation happens after head verification and before publication', async () => {
    const controller = new AbortController();
    let reviewListRequests = 0;
    let reviewPostRequests = 0;
    githubMocks.installationRequest.mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { head: { sha: 'a'.repeat(40) } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        reviewListRequests += 1;
        controller.abort();
        return { data: [] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        reviewPostRequests += 1;
        return { data: { id: 999 } };
      }
      throw new Error(`unexpected route: ${route}`);
    });

    const client = new GitHubAppClient({
      appId: 1,
      clientId: 'client',
      name: 'leverframe',
      privateKey: 'private-key',
      slug: 'leverframe',
      webhookSecret: 'secret',
    });

    await expect(
      client.publishReview({
        expectedHeadSha: 'a'.repeat(40),
        installationId: 42,
        jobId: 7,
        pullRequestNumber: 7,
        repository: 'example/project',
        result,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reviewListRequests).toBe(1);
    expect(reviewPostRequests).toBe(0);
  });
});

describe('review publication identity', () => {
  it('preserves the trusted inline marker when a long finding body is truncated', async () => {
    let publishedBody = '';
    githubMocks.installationRequest.mockImplementation((route: string, parameters: unknown) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { head: { sha: 'a'.repeat(40) } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        return { data: [] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        const request = parameters as { comments: Array<{ body: string }> };
        publishedBody = request.comments[0]?.body ?? '';
        return { data: { id: 999 } };
      }
      throw new Error(`unexpected route: ${route}`);
    });
    const longResult: ReviewResult = {
      ...result,
      findings: [{ ...result.findings[0]!, explanation: 'x'.repeat(61_000) }],
    };
    const publication = prepareReviewPublication(
      longResult,
      new Map([['src/changed.ts', new Set([7])]]),
      7,
    );

    const published = await createClient().publishReview({
      expectedHeadSha: 'a'.repeat(40),
      inlineComments: publication.inlineComments,
      inlineFindingIndexes: publication.inlineFindingIndexes,
      installationId: 42,
      jobId: 7,
      pullRequestNumber: 7,
      repository: 'example/project',
      result: longResult,
      signal: new AbortController().signal,
    });

    expect(published.publishedInlineFingerprints).toEqual([
      publication.inlineComments[0]?.fingerprint,
    ]);
    expect(publishedBody).toHaveLength(60_000);
    expect(parseFindingPublicationMarker(publishedBody)).toEqual({
      fingerprint: publication.inlineComments[0]?.fingerprint,
      jobId: 7,
    });
  });

  it('reports no inline fingerprints after a summary fallback', async () => {
    let postAttempts = 0;
    githubMocks.installationRequest.mockImplementation((route: string, parameters: unknown) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { head: { sha: 'a'.repeat(40) } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        return { data: [] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
        postAttempts += 1;
        const request = parameters as { comments?: unknown[] };
        if (request.comments !== undefined) {
          throw Object.assign(new Error('inline comment rejected'), { status: 422 });
        }
        return { data: { id: 999 } };
      }
      throw new Error(`unexpected route: ${route}`);
    });
    const publication = prepareReviewPublication(
      result,
      new Map([['src/changed.ts', new Set([7])]]),
      7,
    );

    await expect(
      createClient().publishReview({
        expectedHeadSha: 'a'.repeat(40),
        inlineComments: publication.inlineComments,
        inlineFindingIndexes: publication.inlineFindingIndexes,
        installationId: 42,
        jobId: 7,
        pullRequestNumber: 7,
        repository: 'example/project',
        result,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ publishedInlineFingerprints: [], reviewId: 999 });
    expect(postAttempts).toBe(2);
  });

  it('recovers the actual inline fingerprints for a persisted review', async () => {
    const publication = prepareReviewPublication(
      result,
      new Map([['src/changed.ts', new Set([7])]]),
      7,
    );
    githubMocks.installationRequest.mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { head: { sha: 'a'.repeat(40) } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments') {
        return { data: [{ body: publication.inlineComments[0]?.body ?? '' }] };
      }
      throw new Error(`unexpected route: ${route}`);
    });

    await expect(
      createClient().publishReview({
        expectedHeadSha: 'a'.repeat(40),
        inlineComments: publication.inlineComments,
        inlineFindingIndexes: publication.inlineFindingIndexes,
        installationId: 42,
        jobId: 7,
        knownReviewId: 999,
        pullRequestNumber: 7,
        repository: 'example/project',
        result,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      publishedInlineFingerprints: [publication.inlineComments[0]?.fingerprint],
      reviewId: 999,
    });
  });
});

function createClient(): GitHubAppClient {
  return new GitHubAppClient({
    appId: 1,
    clientId: 'client',
    name: 'leverframe',
    privateKey: 'private-key',
    slug: 'leverframe',
    webhookSecret: 'secret',
  });
}
