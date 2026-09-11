import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const representativeFixtures = [
  'default',
  'degraded',
  'unavailable',
  'empty-history',
  'completed-multiple-findings',
] as const;

test.describe('frontend invariants', () => {
  test('desktop app shell keeps sidebar, theme, and locale behavior', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile');

    await page.goto('/en/reviews?fixture=default');

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Korean' }).click();
    await expect(page).toHaveURL(/\/ko\/reviews\?fixture=default/);
  });

  test('desktop inbox keeps operational context stable across health states', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile');

    for (const fixture of ['default', 'degraded'] as const) {
      await page.goto(`/en/reviews?fixture=${fixture}`);
      await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
      await expect(page.getByText('Typical review time', { exact: true })).toBeVisible();
      await expect(page.getByText('Execution failure rate', { exact: true })).toBeVisible();
    }
  });

  test('desktop inbox and detail share the same review page frame width', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile');

    await page.goto('/en/reviews?fixture=default');
    const inboxWidth = await page
      .locator('[data-slot="review-page-frame"]')
      .evaluate((element) => Math.round(element.getBoundingClientRect().width));

    await page.goto('/en/reviews/241?fixture=completed-multiple-findings');
    const detailWidth = await page
      .locator('[data-slot="review-page-frame"]')
      .evaluate((element) => Math.round(element.getBoundingClientRect().width));

    expect(detailWidth).toBe(inboxWidth);
  });

  for (const fixture of representativeFixtures) {
    test(`${fixture} renders without hydration, page, or same-origin resource failures`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      const failedResponses: string[] = [];

      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (
          url.origin === 'http://127.0.0.1:16721' &&
          response.status() >= 400 &&
          !url.pathname.startsWith('/api/')
        ) {
          failedResponses.push(`${response.status()} ${url.pathname}`);
        }
      });

      await page.goto(`/en/reviews?fixture=${fixture}`);
      await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();

      expect(pageErrors, 'uncaught browser errors').toEqual([]);
      expect(failedResponses, 'failed same-origin UI resources').toEqual([]);
    });
  }

  test('review list has no automatically detectable WCAG A/AA violations', async ({ page }) => {
    await page.goto('/en/reviews?fixture=default');

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(result.violations).toEqual([]);
  });

  test('review detail has no automatically detectable WCAG A/AA violations', async ({ page }) => {
    await page.goto('/en/reviews/241?fixture=completed-multiple-findings');

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(result.violations).toEqual([]);
  });

  test('expanded review surfaces remain accessible and never overflow the viewport', async ({
    page,
  }) => {
    await page.goto('/en/reviews/241?fixture=completed-multiple-findings');
    const finding = page.locator('article').first();
    await finding.getByRole('button', { name: 'View evidence' }).click();
    await finding.getByRole('button', { name: 'Evaluate', exact: true }).click();
    await page.getByRole('button', { name: 'Execution details' }).click();

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });

  test('stress content wraps without horizontal overflow', async ({ page }) => {
    await page.goto('/en/reviews/241?fixture=stress');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'A deliberately long pull request title',
    );
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });
});
