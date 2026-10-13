import type { DatabaseSync } from 'node:sqlite';
import {
  type ReviewModelSettings,
  reviewModelSettingsSchema,
  reviewSettingsWriteSchema,
} from '@repo/contracts/review-settings';

export class ReviewSettingsRepository {
  constructor(readonly database: DatabaseSync) {}

  get(defaults: ReviewModelSettings): ReviewModelSettings {
    const row = this.database
      .prepare(
        'SELECT model, reasoning_effort AS reasoningEffort FROM review_settings WHERE id = 1',
      )
      .get();
    return reviewModelSettingsSchema.parse(row ?? defaults);
  }

  save(input: ReviewModelSettings): void {
    const settings = reviewSettingsWriteSchema.parse(input);
    this.database
      .prepare(`
        INSERT INTO review_settings (id, model, reasoning_effort) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET model = excluded.model, reasoning_effort = excluded.reasoning_effort
      `)
      .run(settings.model, settings.reasoningEffort);
  }
}
