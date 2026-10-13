import { connectorMaximumResultBytes } from '@repo/contracts/connectors';

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const backend = process.env.REVIEWER_INTERNAL_URL;
  if (!backend) {
    return Response.json({ error: 'Reviewer connection is not configured.' }, { status: 503 });
  }
  const { path } = await context.params;
  const target = new URL(`/api/v1/${path.map(encodeURIComponent).join('/')}`, backend);
  target.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'last-event-id', 'authorization', 'origin']) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // Finish reading the upload before forwarding, so an early rejection cannot reset it.
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const limit =
    path[0] === 'connectors' && path[1] === 'agent' && path[2] === 'results'
      ? connectorMaximumResultBytes
      : 1024 * 1024;
  if (body && body.byteLength > limit) {
    return Response.json({ error: 'Request body is too large.' }, { status: 413 });
  }
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: 'Reviewer service is unavailable.' }, { status: 503 });
  }
}

export const DELETE = proxy;
export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const PATCH = proxy;
export const POST = proxy;
export const PUT = proxy;
