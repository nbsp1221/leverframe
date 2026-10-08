import { connectorListSchema, pairingSchema } from '@repo/contracts/connectors';

async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/v1/connectors${path}`, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    throw new Error(`connector_http_${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export const loadConnectors = async () => connectorListSchema.parse(await request('')).items;
export const createPairing = async () => pairingSchema.parse(await request('/pairings', {}));

export const revokeConnector = async (id: string) =>
  request(`/${encodeURIComponent(id)}/revoke`, {});

export const loadPairing = async (id: string) =>
  (await request(`/pairings/${encodeURIComponent(id)}`)) as {
    status: 'waiting' | 'connected' | 'expired';
    connectorId: string | null;
  };
