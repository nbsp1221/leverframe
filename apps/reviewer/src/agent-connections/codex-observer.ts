import { z } from 'zod';
import type { CodexRpc } from './codex-observer-rpc.js';
import type { SessionObserver, SessionSnapshot } from './ports.js';

const resultSchema = z.object({
  thread: z.object({
    id: z.string(),
    cwd: z.string(),
    canAcceptDirectInput: z.boolean().nullish(),
    turns: z.array(
      z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()).default([]) }),
    ),
  }),
});
const messageSchema = z.object({
  type: z.literal('userMessage'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** Reads the existing daemon only; it cannot start, resume or interrupt a turn. */
export class CodexSessionObserver implements SessionObserver {
  constructor(
    private readonly rpc: CodexRpc,
    private readonly sessions: ReadonlyMap<string, string>,
  ) {}
  async read(sessionId: string): Promise<SessionSnapshot> {
    const cwd = this.sessions.get(sessionId);
    if (!cwd) {
      throw new Error('session_not_allowed');
    }
    const { thread } = resultSchema.parse(
      await this.rpc.call('thread/read', { threadId: sessionId, includeTurns: true }),
    );
    if (thread.id !== sessionId || thread.cwd !== cwd) {
      throw new Error('session_identity_changed');
    }
    const last = thread.turns.at(-1);
    const loaded = await this.isLoaded(sessionId);
    let state: SessionSnapshot['state'] = 'ready';
    if (!last || !loaded || thread.canAcceptDirectInput !== true) {
      state = 'offline';
    } else if (last.status === 'interrupted' || last.status === 'failed') {
      state = 'cancelled';
    } else if (thread.turns.some((turn) => turn.status === 'inProgress')) {
      state = 'busy';
    } else if (last.status !== 'completed') {
      state = 'offline';
    }
    return {
      revision: last?.id ?? '',
      state,
      messages: thread.turns.flatMap((turn) =>
        turn.items.flatMap((item) => {
          const parsed = messageSchema.safeParse(item);
          return parsed.success
            ? parsed.data.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
            : [];
        }),
      ),
    };
  }

  async isLoaded(sessionId: string): Promise<boolean> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = z
        .object({ data: z.array(z.string()), nextCursor: z.string().nullish() })
        .parse(await this.rpc.call('thread/loaded/list', cursor ? { cursor } : {}));
      if (page.data.includes(sessionId)) {
        return true;
      }
      if (!page.nextCursor) {
        return false;
      }
      if (seen.has(page.nextCursor) || seen.size >= 100) {
        throw new Error('invalid_loaded_session_pagination');
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }
}
