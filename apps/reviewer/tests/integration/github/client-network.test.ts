import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { GitHubAppClient } from '../../../src/github/client.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});

describe('GitHub client network recovery through the real SDK', () => {
  it.each([
    { name: 'one connection reset', resets: 1, status: 200, attempts: 2, recovered: true },
    { name: 'persistent connection resets', resets: 3, status: 200, attempts: 3, recovered: false },
    { name: 'an HTTP 500 response', resets: 0, status: 500, attempts: 1, recovered: false },
  ])('handles $name with a bounded retry budget', async (testCase) => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('/repos/example/project/check-runs/101');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        bodies.push(body);
        if (bodies.length <= testCase.resets) {
          request.socket.resetAndDestroy();
          return;
        }
        response.statusCode = testCase.status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 101, status: 'in_progress' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an ephemeral TCP listener');
    }
    const nativeFetch = globalThis.fetch;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
      const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
        .pathname;
      if (path === '/app/installations/42/access_tokens') {
        return Response.json({
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { checks: 'write' },
          token: 'fixture-installation-token',
        });
      }
      // All SDK requests are intercepted; only the ephemeral loopback server is contacted.
      expect(path).toBe('/repos/example/project/check-runs/101');
      expect(options?.method).toBe('PATCH');
      return nativeFetch(`http://127.0.0.1:${address.port}${path}`, options);
    });
    vi.stubGlobal('fetch', fetch);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = new GitHubAppClient({
        appId: 1,
        clientId: 'fixture-client',
        name: 'fixture',
        privateKey,
        slug: 'fixture',
        webhookSecret: 'fixture-secret',
      });
      const start = client.startCheckRun({
        checkRunId: 101,
        installationId: 42,
        repository: 'example/project',
      });
      if (testCase.recovered) {
        await expect(start).resolves.toBeUndefined();
      } else if (testCase.resets > 0) {
        await expect(start).rejects.toMatchObject({
          cause: { cause: { code: 'ECONNRESET' } },
          status: 500,
        });
      } else {
        await expect(start).rejects.toMatchObject({ response: { status: 500 }, status: 500 });
      }
      expect(bodies).toHaveLength(testCase.attempts);
      expect(bodies.every((body) => body === bodies[0])).toBe(true);
      expect(warnings).toHaveBeenCalledTimes(testCase.resets || 1);
    } finally {
      vi.unstubAllGlobals();
      warnings.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
