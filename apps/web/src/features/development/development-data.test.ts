import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDevelopmentRepositories } from './development-data';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('development repository data', () => {
  it('loads every repository page instead of silently truncating after 100 items', async () => {
    vi.stubEnv('REVIEWER_INTERNAL_URL', 'http://reviewer:3001');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      repository: `example/repository-${index + 1}`,
      default_branch: 'main',
      private: false,
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: firstPage }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { repository: 'example/repository-101', default_branch: 'trunk', private: true },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetch);

    const result = await getDevelopmentRepositories();

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      throw new Error('repository pages were not loaded');
    }
    expect(result.data).toHaveLength(101);
    expect(result.data.slice(0, 100)).toEqual(firstPage);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('page')).toBe('1');
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('page')).toBe('2');
  });
});
