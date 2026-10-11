import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  reviewModels,
  reviewSettingsResponseSchema,
  reviewSettingsWriteSchema,
} from '@repo/contracts/review-settings';

const original = { model: 'gpt-6-astra', reasoningEffort: 'high' };

test('saves a model and reasoning pair through the real API, reloads it, and discards an unsaved edit', async ({
  page,
  request,
}, testInfo) => {
  await request.put('/api/v1/settings/reviews', { data: original });
  try {
    await page.goto('/en/reviews?fixture=default');
    await page.getByRole('link', { name: 'Review settings', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/settings\/reviews/);
    await expect(
      page.getByLabel('Model', { exact: true }).locator('[data-slot="select-value"]'),
    ).toHaveText('GPT-6 Astra');
    await expect(
      page.getByLabel('Reasoning effort', { exact: true }).locator('[data-slot="select-value"]'),
    ).toHaveText('High');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option', { name: 'GPT-6.1 Sol', exact: true }).click();
    await page.getByLabel('Reasoning effort', { exact: true }).click();
    await page.getByRole('option', { name: 'Extra high', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved. Applies to the next review.');
    expect(
      reviewSettingsResponseSchema.parse(
        await (await request.get('/api/v1/settings/reviews')).json(),
      ).current,
    ).toEqual({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
    });
    await page.reload();
    await expect(
      page.getByLabel('Model', { exact: true }).locator('[data-slot="select-value"]'),
    ).toHaveText('GPT-6.1 Sol');
    await expect(
      page.getByLabel('Reasoning effort', { exact: true }).locator('[data-slot="select-value"]'),
    ).toHaveText('Extra high');
    await page.getByLabel('Reasoning effort', { exact: true }).click();
    await page.getByRole('option', { name: 'Low', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(
      page.getByLabel('Reasoning effort', { exact: true }).locator('[data-slot="select-value"]'),
    ).toHaveText('Extra high');
    if (testInfo.project.name === 'mobile') {
      await page.getByRole('link', { name: 'Back to settings', exact: true }).click();
    }
    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/reviews\?fixture=default/);
  } finally {
    await request.put('/api/v1/settings/reviews', { data: original });
  }
});

test('retains the draft and current pair on a failed save, then allows retry', async ({ page }) => {
  let fail = true;
  let current = original;
  await page.route('**/api/v1/settings/reviews', async (route) => {
    if (route.request().method() === 'PUT') {
      if (fail) {
        await route.fulfill({ status: 503, json: { error: 'unavailable' } });
        return;
      }
      current = reviewSettingsWriteSchema.parse(route.request().postDataJSON());
    }
    await route.fulfill({ json: { current, models: reviewModels } });
  });
  await page.goto('/en/settings/reviews');
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('option', { name: 'GPT-6.1 Sol', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Settings could not be saved' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Model', { exact: true }).locator('[data-slot="select-value"]'),
  ).toHaveText('GPT-6.1 Sol');
  await expect(page.locator('[data-slot="badge"]')).toHaveText('GPT-6 Astra · High');
  fail = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. Applies to the next review.');
});

test('does not invent settings when loading fails and recovers on retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/settings/reviews', (route) =>
    route.fulfill({
      status: fail ? 503 : 200,
      json: fail ? { error: 'unavailable' } : { current: original, models: reviewModels },
    }),
  );
  await page.goto('/en/settings/reviews');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Review settings are unavailable' }),
  ).toBeVisible();
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByLabel('Model', { exact: true }).locator('[data-slot="select-value"]'),
  ).toHaveText('GPT-6 Astra');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('protects an unsaved draft during settings navigation', async ({ page }, testInfo) => {
  await page.route('**/api/v1/settings/reviews', (route) =>
    route.fulfill({ json: { current: original, models: reviewModels } }),
  );
  await page.goto('/en/settings/reviews');
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('option', { name: 'GPT-6.1 Sol', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  const leave =
    testInfo.project.name === 'mobile'
      ? page.getByRole('link', { name: 'Back to settings', exact: true })
      : page
          .getByRole('navigation', { name: 'Settings', exact: true })
          .getByRole('link', { name: 'Connected computers', exact: true });
  await leave.click();
  await expect(page).toHaveURL(/\/en\/settings\/reviews/);
  await expect(
    page.getByLabel('Model', { exact: true }).locator('[data-slot="select-value"]'),
  ).toHaveText('GPT-6.1 Sol');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await leave.click();
  if (testInfo.project.name === 'mobile') {
    await page
      .getByRole('navigation', { name: 'Settings categories', exact: true })
      .getByRole('link', { name: /^Connected computers/ })
      .click();
  }
  await expect(
    page.getByRole('heading', { name: 'Connected computers', exact: true }),
  ).toBeVisible();
});

for (const locale of ['en', 'ko']) {
  for (const theme of ['light', 'dark']) {
    test(`${locale} ${theme}: settings share navigation, fit the viewport, and are accessible`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.route('**/api/v1/settings/reviews', (route) =>
        route.fulfill({ json: { current: original, models: reviewModels } }),
      );
      await page.goto(`/${locale}/settings/reviews`);
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        locale === 'ko' ? '코드 리뷰 봇' : 'Code review bot',
      );
      if (testInfo.project.name === 'desktop') {
        const settings = page.getByRole('navigation', {
          name: locale === 'ko' ? '설정' : 'Settings',
          exact: true,
        });
        await expect(
          settings.getByRole('link', {
            name: locale === 'ko' ? '코드 리뷰 봇' : 'Code Review Bot',
            exact: true,
          }),
        ).toHaveAttribute('aria-current', 'page');
      } else {
        await expect(page.locator('aside')).toBeHidden();
        await expect(
          page.getByRole('link', {
            name: locale === 'ko' ? '설정으로 돌아가기' : 'Back to settings',
            exact: true,
          }),
        ).toBeVisible();
      }
      await expect(
        page
          .getByLabel(locale === 'ko' ? '모델' : 'Model', { exact: true })
          .locator('[data-slot="select-value"]'),
      ).toHaveText('GPT-6 Astra');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      ).toBe(false);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page
        .getByRole('navigation', { name: locale === 'ko' ? '이동 경로' : 'Breadcrumb' })
        .getByRole('link', { name: locale === 'ko' ? '설정' : 'Settings', exact: true })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        locale === 'ko' ? '설정' : 'Settings',
      );
      await expect(
        page
          .getByRole('navigation', { name: locale === 'ko' ? '설정 항목' : 'Settings categories' })
          .getByRole('link'),
      ).toHaveCount(2);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
    });
  }
}
