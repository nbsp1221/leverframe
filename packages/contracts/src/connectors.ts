import { z } from 'zod';

// Observation results can include a long conversation; match the native observer frame limit.
export const connectorMaximumResultBytes = 32 * 1024 * 1024;

export const connectorHealthSchema = z
  .object({
    codex: z.enum(['ready', 'unavailable']),
    skill: z.enum(['installed', 'missing']),
  })
  .strict();
export const connectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  status: z.enum(['online', 'offline', 'revoked']),
  lastSeenAt: z.string().nullable(),
  health: connectorHealthSchema,
  sessionCount: z.number(),
  lastQuestionAt: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
});

export type Connector = z.infer<typeof connectorSchema>;

export const connectorListSchema = z.object({ items: z.array(connectorSchema) });
export const pairingSchema = z.object({ id: z.string(), code: z.string(), expiresAt: z.string() });
export const sessionSnapshotSchema = z.object({
  revision: z.string(),
  state: z.enum(['ready', 'busy', 'cancelled', 'offline']),
  messages: z.array(z.string()),
});
export const connectorCommandSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  kind: z.enum(['read', 'prepare', 'send', 'close']),
  preparedId: z.string().optional(),
  message: z.string().optional(),
  revision: z.string().optional(),
});

export type ConnectorCommand = z.infer<typeof connectorCommandSchema>;

export const connectorResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      snapshot: sessionSnapshotSchema.optional(),
      preparedId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['offline', 'busy', 'superseded', 'unsupported', 'unconfirmed']),
    })
    .strict(),
]);

export type ConnectorResult = z.infer<typeof connectorResultSchema>;
