import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcLineClient } from '../../../src/codex/app-server.js';

function nextLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    stream.once('data', (chunk: Buffer) => {
      const value: unknown = JSON.parse(chunk.toString('utf8').trim());
      if (value === null || typeof value !== 'object') {
        throw new Error('expected an object message');
      }
      resolve(value as Record<string, unknown>);
    });
  });
}

describe('JsonRpcLineClient', () => {
  it('correlates responses while forwarding streamed notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notification = vi.fn();
    const client = new JsonRpcLineClient(input, output, { onNotification: notification });
    const written = nextLine(input);
    const response = client.request('thread/start', { cwd: '/workspace' });
    const request = await written;

    expect(request).toMatchObject({ id: 1, method: 'thread/start', params: { cwd: '/workspace' } });
    output.write(
      `${JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage' } } })}\n`,
    );
    output.write(`${JSON.stringify({ id: 1, result: { thread: { id: 'thread-1' } } })}\n`);
    await expect(response).resolves.toEqual({ thread: { id: 'thread-1' } });
    expect(notification).toHaveBeenCalledWith({
      method: 'item/completed',
      params: { item: { type: 'agentMessage' } },
    });
    client.close();
  });

  it('answers server requests through the explicit interrupt handler', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcLineClient(input, output, {
      onRequest: (request) =>
        Promise.resolve({ accepted: request.method === 'item/tool/requestUserInput' }),
    });
    const written = nextLine(input);
    output.write(
      `${JSON.stringify({ id: 'request-1', method: 'item/tool/requestUserInput', params: { question: 'Choose.' } })}\n`,
    );

    await expect(written).resolves.toEqual({ id: 'request-1', result: { accepted: true } });
    client.close();
  });

  it('fails closed on malformed protocol output and bounded request timeouts', async () => {
    const malformedInput = new PassThrough();
    const malformedOutput = new PassThrough();
    const malformed = new JsonRpcLineClient(malformedInput, malformedOutput);
    const pending = malformed.request('thread/read');
    malformedOutput.write('not-json\n');
    await expect(pending).rejects.toThrow(/malformed JSON/);

    const timeoutInput = new PassThrough();
    const timeoutOutput = new PassThrough();
    const timeout = new JsonRpcLineClient(timeoutInput, timeoutOutput, {
      requestTimeoutMilliseconds: 5,
    });
    await expect(timeout.request('thread/read')).rejects.toThrow(/timed out/);
    timeout.close();
  });
});
