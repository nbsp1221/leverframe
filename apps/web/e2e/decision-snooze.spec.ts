import { expect, test } from '@playwright/test';
import { decisionListSchema, decisionSchema } from '@repo/contracts/decisions';

for (const cacheUnavailable of [false, true]) {
  test(`a failed snooze preserves the draft, unavailable cache: ${cacheUnavailable}`, async ({
    page,
    request,
  }) => {
    if (cacheUnavailable) {
      await page.addInitScript(() => {
        const setItem = Reflect.get(Storage.prototype, 'setItem');
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('decision-draft:')) {
            throw new DOMException('Draft cache is full', 'QuotaExceededError');
          }
          setItem.call(this, key, value);
        };
      });
    }
    const seed = await request.get('/api/v1/decisions/dr-104');
    const item = decisionSchema.parse({
      ...decisionSchema.parse(await seed.json()),
      id: 'failed-snooze',
      status: 'awaiting_answer',
      revision: 0,
      answers: [],
      events: [],
      snoozedUntil: null,
    });
    await page.route('**/api/v1/decisions', (route) => route.fulfill({ json: { items: [item] } }));
    await page.route('**/api/v1/decisions/failed-snooze/snooze', (route) =>
      route.fulfill({ status: 503, json: { error: 'unavailable' } }),
    );
    await page.goto('/en/decisions?request=failed-snooze');
    const input = page.getByLabel('Your view or additional conditions');
    const text = 'Keep this answer even if the request cannot be snoozed.';
    await input.fill(text);
    await page.getByRole('button', { name: 'Remind me in 1 hour' }).click();
    await expect(page.locator('article').getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue(text);
    await expect(page.getByRole('button', { name: 'Send response', exact: true })).toBeEnabled();
  });
}

for (const reloadBeforeAcknowledgement of [false, true]) {
  test(`a delayed wake preserves the draft, reload before acknowledgement: ${reloadBeforeAcknowledgement}`, async ({
    page,
    request,
  }) => {
    const seed = await request.get('/api/v1/decisions/dr-104');
    const id = 'delayed-wake';
    let item = decisionSchema.parse({
      ...decisionSchema.parse(await seed.json()),
      id,
      status: 'awaiting_answer',
      revision: 0,
      answers: [],
      events: [],
      snoozedUntil: null,
    });
    await page.route('**/api/v1/decisions', (route) => route.fulfill({ json: { items: [item] } }));
    const committed = Promise.withResolvers<void>();
    const acknowledgement = Promise.withResolvers<void>();
    await page.route(`**/api/v1/decisions/${id}/snooze`, async (route) => {
      const deferred = item.snoozedUntil === null;
      expect(route.request().postDataJSON()).toEqual({ deferred, expectedRevision: item.revision });
      item = {
        ...item,
        revision: item.revision + 1,
        snoozedUntil: deferred ? new Date(Date.now() + 3600000).toISOString() : null,
      };
      if (!deferred) {
        committed.resolve();
        await acknowledgement.promise;
      }
      await route.fulfill({ json: item });
    });
    await page.goto(`/en/decisions?request=${id}`);
    const input = page.getByLabel('Your view or additional conditions');
    const submit = page.getByRole('button', { name: 'Send response', exact: true });
    const text = 'Keep my conditions while I return to this request.';
    await input.fill(text);
    await page.getByRole('button', { name: 'Remind me in 1 hour' }).click();
    await expect(page.getByText('Saved for later', { exact: true })).toBeVisible();
    try {
      const polled = page.waitForResponse(
        async (response) =>
          response.url().endsWith('/api/v1/decisions') &&
          response.request().method() === 'GET' &&
          decisionListSchema
            .parse(await response.json())
            .items.some((value) => value.revision === 2),
      );
      await page.getByRole('button', { name: 'Answer now' }).click();
      await committed.promise;
      if (reloadBeforeAcknowledgement) {
        await page.reload();
        await polled;
        acknowledgement.resolve();
        await expect(input).toHaveValue(text);
        await expect(submit).toBeDisabled();
        await expect(page.getByText('The request changed while you were writing')).toBeVisible();
        await page.getByRole('button', { name: 'I reviewed the latest context' }).click();
      } else {
        await polled;
        // Polling must not mount an editable form from the pre-wake draft.
        await expect(input).toHaveCount(0);
        acknowledgement.resolve();
      }
      await expect(input).toHaveValue(text);
      await expect(submit).toBeEnabled();
      await expect(page.getByText('The request changed while you were writing')).toHaveCount(0);
      await page.reload();
      await expect(input).toHaveValue(text);
      await expect(submit).toBeEnabled();
    } finally {
      acknowledgement.resolve();
    }
  });
}
