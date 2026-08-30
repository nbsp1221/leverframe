import { z } from 'zod';
import type { AppServerNotification } from '../codex/app-server.js';
import type { DevelopmentEventInput } from '../storage/development-repository.js';

export const executionPhases = new Set([
  'PREPARING',
  'PLANNING',
  'IMPLEMENTING',
  'VERIFYING',
  'PUBLISHING',
]);

export const clarificationRequestSchema = z.object({
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  itemId: z.string().min(1).max(255),
  isBlocking: z.boolean().default(true),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        header: z.string().min(1).max(120),
        question: z.string().min(1).max(2000),
        isOther: z.boolean().default(false),
        isSecret: z.boolean().default(false),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              description: z.string().max(1000),
            }),
          )
          .max(3)
          .nullable()
          .optional()
          .transform((value) => value ?? null),
      }),
    )
    .min(1)
    .max(3),
});

export const developmentInstructions =
  'You are the implementation agent owned by Leverframe. Follow repository guidance. Ask only when ambiguity materially changes behavior or scope. Never push, create or modify a pull request, merge, deploy, or expose secrets without an explicit capability-bearing publication turn.';

export const implementationPrompt =
  'The operator approved the plan. Implement it completely, follow repository guidance, use the supplied commit skill for coherent local commits, and run repository-appropriate tests, lint, type checks, builds, and real QA. Do not push or create or modify a pull request.';

export function planningPrompt(goal: string): string {
  return `Analyze the repository and propose the smallest coherent implementation plan for this accepted goal:\n\n${goal}\n\nDo not modify files in this planning turn. State material ambiguities as explicit questions. Otherwise provide a concrete plan, verification strategy, and risks for operator approval.`;
}

export function reviewFixPrompt(
  findings: Array<{
    evidence: string;
    file: string;
    fingerprint: string;
    line: number;
    title: string;
  }>,
): string {
  const boundedFindings = findings.slice(0, 50).map((finding) => ({
    evidence: sanitize(finding.evidence, 4000),
    file: sanitize(finding.file, 1000),
    fingerprint: finding.fingerprint,
    line: finding.line,
    title: sanitize(finding.title, 1000),
  }));
  return `The existing Leverframe review found the following actionable issues on the current published candidate. Evaluate every finding against the code rather than trusting it blindly, fix only valid issues, preserve evidence for rejected findings, commit coherent changes with the supplied commit skill, and rerun repository-appropriate verification and real QA. Do not push or create or modify a pull request.\n\n${JSON.stringify(boundedFindings)}`;
}

export function normalizedNotification(
  notification: AppServerNotification,
): DevelopmentEventInput | undefined {
  if (notification.method === 'item/completed') {
    const params = notification.params as { item?: { type?: string; text?: string; id?: string } };
    if (params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      return {
        type: 'agent_message',
        source: 'CODEX',
        trust: 'AGENT_CLAIMED',
        payload: { message: sanitize(params.item.text, 20_000), item_id: params.item.id ?? null },
      };
    }
  }
  if (notification.method === 'turn/completed') {
    return { type: 'turn_completed', source: 'CODEX', trust: 'HARNESS_OBSERVED' };
  }
  return undefined;
}

export function observed(
  type: string,
  payload: Record<string, unknown> = {},
): DevelopmentEventInput {
  return { type, payload, source: 'LEVERFRAME', trust: 'SYSTEM_OBSERVED' };
}

export function sanitize(value: string, maximum: number): string {
  return value
    .replaceAll(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replaceAll(/\/tmp\/[^\s]+/g, '[private-path]')
    .replaceAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .slice(0, maximum);
}

export function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;

    const abort = () => {
      clearTimeout(timeout);
      reject(new Error('development controller stopped'));
    };

    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      reject(new Error(message));
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };

    if (signal?.aborted === true) {
      cleanup();
      reject(new Error('development controller stopped'));
      return;
    }
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
