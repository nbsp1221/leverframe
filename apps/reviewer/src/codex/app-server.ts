import type { Readable, Writable } from 'node:stream';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { runProcess } from '../system/process.js';

export const codexAppServerRuntime = {
  cliVersion: '0.149.1',
  protocolSchemaSha256: '6f76cce25156d405f1da54f205751e38f7b9eb42246ac0742b9958dd60275350',
} as const;

type JsonRpcId = number;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: NodeJS.Timeout;
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export class JsonRpcLineClient {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #input: Writable;
  readonly #onNotification: (notification: AppServerNotification) => void;
  readonly #onRequest: (request: AppServerRequest) => Promise<unknown>;
  readonly #requestTimeoutMilliseconds: number;
  #nextId = 1;
  #closed = false;

  constructor(
    input: Writable,
    output: Readable,
    options: {
      onNotification?: (notification: AppServerNotification) => void;
      onRequest?: (request: AppServerRequest) => Promise<unknown>;
      requestTimeoutMilliseconds?: number;
    } = {},
  ) {
    this.#input = input;
    this.#onNotification = options.onNotification ?? (() => {});
    this.#onRequest =
      options.onRequest ??
      (() => Promise.reject(new Error('interactive App Server request is unsupported')));
    this.#requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 30_000;
    const lines = createInterface({ input: output });
    lines.on('line', (line) => this.handleLine(line));
    lines.on('close', () => this.close(new Error('Codex App Server output closed')));
    output.on('error', (error) => this.close(error));
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error('Codex App Server transport is closed'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.#requestTimeoutMilliseconds);
      this.#pending.set(id, { reject, resolve, timeout });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.#closed) {
      throw new Error('Codex App Server transport is closed');
    }
    this.write({ method, params });
  }

  close(error: Error = new Error('Codex App Server transport closed')): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) {
      this.close(new Error('Codex App Server emitted an oversized protocol line'));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.close(new Error('Codex App Server emitted malformed JSON'));
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.close(new Error('Codex App Server emitted a non-object message'));
      return;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.id === 'number' && ('result' in record || 'error' in record)) {
      const pending = this.#pending.get(record.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(record.id);
      clearTimeout(pending.timeout);
      if ('error' in record && record.error !== undefined) {
        pending.reject(new Error(`Codex App Server error: ${boundedJson(record.error)}`));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (
      (typeof record.id === 'number' || typeof record.id === 'string') &&
      typeof record.method === 'string'
    ) {
      const request = {
        id: record.id,
        method: record.method,
        ...('params' in record ? { params: record.params } : {}),
      };
      void this.#onRequest(request)
        .then((result) => this.write({ id: request.id, result }))
        .catch((error: unknown) =>
          this.write({
            id: request.id,
            error: {
              code: -32_000,
              message: error instanceof Error ? error.message.slice(0, 1000) : 'request rejected',
            },
          }),
        );
      return;
    }
    if (typeof record.method === 'string') {
      this.#onNotification({
        method: record.method,
        ...('params' in record ? { params: record.params } : {}),
      });
    }
  }

  private write(message: object): void {
    this.#input.write(`${JSON.stringify(message)}\n`);
  }
}

const threadResponseSchema = z.object({ thread: z.object({ id: z.string().uuid() }) });
const skillsResponseSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      errors: z.array(z.unknown()),
      skills: z.array(
        z.object({
          enabled: z.boolean(),
          name: z.string(),
          path: z.string(),
        }),
      ),
    }),
  ),
});
const turnResponseSchema = z.object({ turn: z.object({ id: z.string().uuid() }) });

export class CodexAppServer {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #rpc: JsonRpcLineClient;
  #stderrTail = Buffer.alloc(0);

  private constructor(
    process: ChildProcessWithoutNullStreams,
    options: {
      onNotification?: (notification: AppServerNotification) => void;
      onRequest?: (request: AppServerRequest) => Promise<unknown>;
    },
  ) {
    this.#process = process;
    this.#rpc = new JsonRpcLineClient(process.stdin, process.stdout, options);
    process.stderr.on('data', (chunk: Uint8Array) => {
      const next = Buffer.concat([this.#stderrTail, Buffer.from(chunk)]);
      this.#stderrTail =
        next.byteLength <= 64 * 1024 ? next : next.subarray(next.byteLength - 64 * 1024);
    });
    process.on('exit', (code, signal) => {
      const detail = this.#stderrTail.toString('utf8').trim().slice(-4000);
      this.#rpc.close(
        new Error(
          `Codex App Server exited (${code ?? signal ?? 'unknown'})${detail === '' ? '' : `: ${detail}`}`,
        ),
      );
    });
  }

  static async launch(input: {
    sandboxName: string;
    workspaceDirectory: string;
    onNotification?: (notification: AppServerNotification) => void;
    onRequest?: (request: AppServerRequest) => Promise<unknown>;
  }): Promise<CodexAppServer> {
    const version = await runProcess('sbx', ['exec', input.sandboxName, 'codex', '--version'], {
      timeoutMilliseconds: 30_000,
    });
    if (version.stdout.trim() !== `codex-cli ${codexAppServerRuntime.cliVersion}`) {
      throw new Error(
        `Unsupported Codex App Server runtime: expected ${codexAppServerRuntime.cliVersion}`,
      );
    }
    const child = spawn(
      'sbx',
      [
        'exec',
        '-i',
        '-w',
        input.workspaceDirectory,
        input.sandboxName,
        'codex',
        'app-server',
        '--stdio',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const server = new CodexAppServer(child, {
      ...(input.onNotification === undefined ? {} : { onNotification: input.onNotification }),
      ...(input.onRequest === undefined ? {} : { onRequest: input.onRequest }),
    });
    await server.initialize();
    return server;
  }

  async setSkillRoots(roots: readonly string[]): Promise<void> {
    await this.#rpc.request('skills/extraRoots/set', { extraRoots: roots });
  }

  async listSkills(cwd: string): Promise<Array<{ enabled: boolean; name: string; path: string }>> {
    const response = skillsResponseSchema.parse(
      await this.#rpc.request('skills/list', { cwds: [cwd], forceReload: true }),
    );
    return response.data.flatMap((entry) => entry.skills);
  }

  async startThread(input: {
    cwd: string;
    model: string;
    developerInstructions: string;
  }): Promise<string> {
    const response = threadResponseSchema.parse(
      await this.#rpc.request('thread/start', {
        approvalPolicy: 'never',
        cwd: input.cwd,
        developerInstructions: input.developerInstructions,
        ephemeral: false,
        model: input.model,
        sandbox: 'danger-full-access',
      }),
    );
    return response.thread.id;
  }

  async resumeThread(input: { threadId: string; cwd: string }): Promise<void> {
    const response = threadResponseSchema.parse(
      await this.#rpc.request('thread/resume', {
        approvalPolicy: 'never',
        cwd: input.cwd,
        sandbox: 'danger-full-access',
        threadId: input.threadId,
      }),
    );
    if (response.thread.id !== input.threadId) {
      throw new Error('Codex App Server resumed a different thread');
    }
  }

  async startTurn(input: {
    threadId: string;
    prompt: string;
    skills?: readonly { name: string; path: string }[];
  }): Promise<string> {
    const userInput = [
      ...(input.skills ?? []).map((skill) => ({
        type: 'skill',
        name: skill.name,
        path: skill.path,
      })),
      { type: 'text', text: input.prompt },
    ];
    const response = turnResponseSchema.parse(
      await this.#rpc.request('turn/start', {
        approvalPolicy: 'never',
        input: userInput,
        sandboxPolicy: { type: 'dangerFullAccess' },
        threadId: input.threadId,
      }),
    );
    return response.turn.id;
  }

  close(): void {
    this.#rpc.close();
    this.#process.stdin.end();
    if (this.#process.exitCode === null && this.#process.signalCode === null) {
      this.#process.kill('SIGTERM');
    }
  }

  private async initialize(): Promise<void> {
    await this.#rpc.request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: 'leverframe',
        title: 'Leverframe',
        version: '0.0.0',
      },
    });
    this.#rpc.notify('initialized');
  }
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return 'unserializable error';
  }
}
