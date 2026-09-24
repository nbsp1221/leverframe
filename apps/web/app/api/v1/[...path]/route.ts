import { env } from 'node:process';

const maximumRequestBytes = 1024 * 1024;
const forwardedRequestHeaders = ['accept', 'content-type', 'last-event-id'] as const;
const forwardedResponseHeaders = ['cache-control', 'content-type', 'x-accel-buffering'] as const;

export const dynamic = 'force-dynamic';

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const configured = env.REVIEWER_INTERNAL_URL;
  if (!configured) {
    return Response.json({ error: 'Reviewer connection is not configured.' }, { status: 503 });
  }
  let base: URL;
  try {
    base = new URL(`${configured.replace(/\/+$/, '')}/`);
    if (!['http:', 'https:'].includes(base.protocol)) {
      throw new Error('invalid reviewer protocol');
    }
  } catch {
    return Response.json({ error: 'Reviewer connection is invalid.' }, { status: 503 });
  }
  const { path } = await context.params;
  if (
    path.length === 0 ||
    path.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return Response.json({ error: 'Invalid API path.' }, { status: 400 });
  }
  const incoming = new URL(request.url);
  const target = new URL(`api/v1/${path.map(encodeURIComponent).join('/')}`, base);
  target.search = incoming.search;
  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  let body: ArrayBuffer | undefined;
  if (!['GET', 'HEAD'].includes(request.method)) {
    body = await request.arrayBuffer();
    if (body.byteLength > maximumRequestBytes) {
      return Response.json({ error: 'Request body is too large.' }, { status: 413 });
    }
  }
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      redirect: 'manual',
    });
    const responseHeaders = new Headers();
    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        responseHeaders.set(name, value);
      }
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: 'Reviewer service is unavailable.' }, { status: 503 });
  }
}

export const DELETE = proxy;
export const GET = proxy;
export const PATCH = proxy;
export const POST = proxy;
export const PUT = proxy;
