/** Provider-neutral execution boundary. Session identifiers are opaque within a connection. */
export class UnsupportedSessionChannel extends Error {}

export interface SessionSnapshot {
  revision: string;
  state: 'ready' | 'busy' | 'cancelled' | 'offline';
  messages: readonly string[];
}

export interface SessionObserver {
  read(sessionId: string): Promise<SessionSnapshot>;
}

export interface PreparedSession {
  /** A completed prompt is not evidence that the user's decision was applied. */
  send(message: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionChannel {
  prepare(sessionId: string, cwd: string, expectedRevision?: string): Promise<PreparedSession>;
}

export interface AgentConnection {
  id: string;
  agentId: string;
  sessions: ReadonlyMap<string, string>;
  observer: SessionObserver;
  channel: SessionChannel;
}
