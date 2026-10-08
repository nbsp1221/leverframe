import type { Decision } from '@repo/contracts/decisions';
import type { DecisionService } from './service.js';

/** Bounded delivery across sessions; one unresolved head per session keeps its order. */
export class DecisionDeliveryWorker {
  private readonly active = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { attempts: number; after: number }>();
  private stopped = false;

  constructor(
    private readonly service: DecisionService,
    private readonly sessionKey: (item: Decision) => string,
    private readonly delivered: (item: Decision) => void,
    private readonly now = Date.now,
    private readonly concurrency = 4,
  ) {}

  async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const heads = new Set<string>();
    for (const item of this.service.list()) {
      if (!['queued', 'delivery_failed'].includes(item.status)) {
        continue;
      }
      const key = this.sessionKey(item);
      if (heads.has(key)) {
        continue;
      }
      heads.add(key);
      if (
        this.active.has(key) ||
        this.active.size >= this.concurrency ||
        (item.status === 'delivery_failed' && item.deliveryIssue === 'unsupported')
      ) {
        continue;
      }
      const retry = this.retries.get(item.id);
      if (item.status === 'delivery_failed' && retry && retry.after > this.now()) {
        continue;
      }
      if (item.status === 'queued') {
        this.retries.delete(item.id);
      }
      const task = this.dispatch(item).finally(() => this.active.delete(key));
      this.active.set(key, task);
    }
    await Promise.allSettled(this.active.values());
  }

  private async dispatch(item: Decision): Promise<void> {
    try {
      await this.service.dispatch(item.id);
      const current = this.service.get(item.id);
      if (current.status === 'delivered') {
        this.delivered(current);
      }
      if (current.status !== 'delivery_failed') {
        this.retries.delete(item.id);
        return;
      }
    } catch {
      // Storage/observer failures must not stop unrelated session deliveries.
      console.error('Decision delivery attempt failed');
    }
    const attempts = (this.retries.get(item.id)?.attempts ?? 0) + 1;
    this.retries.set(item.id, {
      attempts,
      after: this.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.active.values());
  }
}
