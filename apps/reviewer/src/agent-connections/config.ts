import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentConnection } from './ports.js';
import { AcpSessionChannel } from './acp-channel.js';
import { CodexObserverRpc } from './codex-observer-rpc.js';
import { CodexSessionObserver } from './codex-observer.js';

const path = z.string().refine(isAbsolute, 'Absolute path required');
const transport = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stdio'),
      command: path,
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('websocket'),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'wss:' ||
          (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        );
      }, 'Use wss or a loopback SSH tunnel'),
      tokenFile: path.optional(),
    })
    .strict(),
]);
const connection = z
  .object({
    id: z.string().min(1).max(100),
    agentId: z.string().min(1),
    sessions: z.record(z.string().min(1), path),
    observer: z.object({ kind: z.literal('codex-desktop'), socketPath: path }).strict(),
    transport: z.union([
      transport,
      z.object({ kind: z.literal('codex-desktop'), bridgePath: path, websocatPath: path }).strict(),
    ]),
  })
  .strict();
export const decisionRuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    databasePath: path,
    tokenFile: path,
    legacyConnectionId: z.string().min(1),
    connections: z.array(connection).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.connections.map((item) => item.id);
    if (
      new Set(ids).size !== ids.length ||
      (ids.length > 0 && !ids.includes(value.legacyConnectionId))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Connection IDs must be unique and include legacyConnectionId',
      });
    }
  });

export type DecisionRuntimeConfig = z.infer<typeof decisionRuntimeConfigSchema>;

export function loadDecisionRuntimeConfig(configPath: string): DecisionRuntimeConfig {
  return decisionRuntimeConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
}

export function createAgentConnections(
  config: DecisionRuntimeConfig,
): Map<string, AgentConnection> {
  return new Map(
    config.connections.map((item) => {
      const sessions = new Map(Object.entries(item.sessions));
      const selected =
        item.transport.kind === 'codex-desktop'
          ? {
              kind: 'stdio' as const,
              command: process.execPath,
              args: [fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp'))],
              env: {
                CODEX_PATH: item.transport.bridgePath,
                LEVERFRAME_CODEX_SOCKET: item.observer.socketPath,
                LEVERFRAME_WEBSOCAT_PATH: item.transport.websocatPath,
              },
            }
          : item.transport;
      return [
        item.id,
        {
          id: item.id,
          agentId: item.agentId,
          sessions,
          observer: new CodexSessionObserver(
            new CodexObserverRpc(item.observer.socketPath),
            sessions,
          ),
          channel: new AcpSessionChannel(selected),
        },
      ];
    }),
  );
}
