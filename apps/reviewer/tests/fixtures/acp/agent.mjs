import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

new AgentSideConnection(
  () => ({
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: process.env.ACP_NO_LOAD !== '1' },
    }),
    newSession: () => ({ sessionId: 'unused' }),
    authenticate: () => ({}),
    loadSession: ({ sessionId }) => {
      if (sessionId !== 'existing') {
        throw new Error('unknown session');
      }
      return {};
    },
    prompt: () => {
      if (process.env.ACP_DROP === '1') {
        process.exit(0);
      }
      return { stopReason: 'end_turn' };
    },
    cancel: () => {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
