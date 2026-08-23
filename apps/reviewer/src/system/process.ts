import { execa } from 'execa';

export interface ProcessResult {
  stderr: string;
  stdout: string;
}

interface ProcessOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
}

interface StreamingProcessOptions extends ProcessOptions {
  onStderr?: (chunk: string | Uint8Array) => void;
  onStdout?: (chunk: string | Uint8Array) => void;
  tailBytes?: number;
}

export async function runProcess(
  command: string,
  arguments_: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const result = await execa(command, arguments_, {
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.input === undefined ? {} : { input: options.input }),
    encoding: 'utf8',
    extendEnv: options.environment === undefined,
    timeout: options.timeoutMilliseconds ?? 10 * 60 * 1000,
  });
  return { stderr: result.stderr, stdout: result.stdout };
}

export async function runStreamingProcess(
  command: string,
  arguments_: readonly string[],
  options: StreamingProcessOptions = {},
): Promise<ProcessResult> {
  const subprocess = execa(command, arguments_, {
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.input === undefined ? {} : { input: options.input }),
    buffer: false,
    encoding: 'utf8',
    extendEnv: options.environment === undefined,
    timeout: options.timeoutMilliseconds ?? 10 * 60 * 1000,
  });
  const maxTailBytes = options.tailBytes ?? 64 * 1024;
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  subprocess.stdout?.on('data', (chunk: string | Uint8Array) => {
    stdout = appendTail(stdout, chunk, maxTailBytes);
    options.onStdout?.(chunk);
  });
  subprocess.stderr?.on('data', (chunk: string | Uint8Array) => {
    stderr = appendTail(stderr, chunk, maxTailBytes);
    options.onStderr?.(chunk);
  });
  try {
    await subprocess;
  } catch (error) {
    const stderrText = stderr.toString('utf8').trim();
    if (error instanceof Error && stderrText !== '' && !error.message.includes(stderrText)) {
      error.message = `${error.message}\n${stderrText}`;
    }
    throw error;
  }
  return { stderr: stderr.toString('utf8'), stdout: stdout.toString('utf8') };
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: string | Uint8Array,
  maxBytes: number,
): Buffer<ArrayBufferLike> {
  const next = Buffer.concat([
    current,
    typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk),
  ]);
  return next.byteLength <= maxBytes ? next : next.subarray(next.byteLength - maxBytes);
}
