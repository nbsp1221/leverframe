import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { decisionSchema } from '@repo/contracts/decisions';

test('a response survives navigation and research returns to the same decision', async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const id = mobile ? 'dr-102' : 'dr-101';
  await page.goto('/en/decisions');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  if (mobile) {
    await page.getByRole('button', { name: /Assistant/ }).click();
  }
  const article = page.locator('article');
  const input = page.getByLabel('Your view or additional conditions');
  const recommendedOption = article.getByRole('button', { name: /AI recommended/ });
  await expect(recommendedOption).toHaveCount(1);
  await expect(recommendedOption).toHaveAttribute('aria-pressed', 'false');
  await expect(article.getByText('AI recommended', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send response', exact: true })).toBeDisabled();
  await expect(article.getByText('Why recommended:', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Background and evidence', exact: true }).click();
  await expect(article.getByText('Why recommended:', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Background and evidence', exact: true }).click();
  if (!mobile) {
    const action = await page
      .getByRole('button', { name: 'Send response', exact: true })
      .boundingBox();
    expect(action && action.y + action.height).toBeLessThan(1080);
  }
  await expect(page.getByRole('region', { name: 'Request history' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Scope of your response' })).toBeVisible();
  const initialAccessibility = await new AxeBuilder({ page }).include('main').analyze();
  expect(initialAccessibility.violations).toEqual([]);
  await input.fill('Compare the impact before changing the policy.');
  await page.getByRole('button', { name: 'Remind me in 1 hour' }).click();
  await expect(page.getByText('Saved for later', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Answer now' }).click();
  await page.reload();
  await expect(input).toHaveValue('Compare the impact before changing the policy.');
  await page.getByRole('button', { name: 'Request research', exact: true }).click();
  await article.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`request=${id}`));
  await page.getByRole('button', { name: 'Request history', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Request history' })).toContainText(
    'Your response was saved',
  );
  await expect(page.getByRole('region', { name: 'Request history' })).toContainText(
    'Further input requested',
    { timeout: 15_000 },
  );
  await expect(article).toContainText('Needs response');
  await expect(input).toHaveValue('');
  await page
    .getByRole('button', { name: mobile ? /^매일 저녁 8시에 요약/ : /^합계에 미확정 표시/ })
    .click();
  await page.getByRole('button', { name: 'Send response', exact: true }).click();
  await expect(article.getByText('Application reported', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.reload();
  await expect(article.getByText('Application reported', { exact: true }).first()).toBeVisible();
  await expect(article.getByText('AI recommended', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page }).include('main').analyze();
  expect(accessibility.violations).toEqual([]);
});

test('a saved response can be retried and a superseded request cannot accept input', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile');
  await page.goto('/en/decisions?request=dr-103');
  await page.getByRole('button', { name: 'Resend saved response' }).click();
  await page.getByRole('button', { name: 'Request history', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Request history' })).toContainText(
    'Further input requested',
    { timeout: 15_000 },
  );
  const response = await request.get('/api/v1/decisions/dr-103');
  const item = decisionSchema.parse(await response.json());
  expect(item.answers).toHaveLength(1);
  expect(item.answers[0]?.id).toBe('seed-operations');
  await page.goto('/en/decisions?request=dr-104');
  await expect(page.locator('article')).toContainText('Superseded');
  await expect(page.getByRole('button', { name: 'Send response' })).toHaveCount(0);
});

test('returning from a request preserves its filtered list', async ({ page }, testInfo) => {
  await page.goto('/en/decisions?view=closed&q=Catalog');
  await page.getByRole('button', { name: /Catalog/ }).click();
  await expect(page.locator('article')).toContainText('Catalog');
  await page.reload();
  await expect(page.locator('article')).toContainText('Catalog');
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('group', { name: 'Request status' })).toBeHidden();
    await page.getByRole('button', { name: 'Back to requests' }).click();
  }
  await expect(page.getByRole('textbox', { name: 'Search projects or requests' })).toHaveValue(
    'Catalog',
  );
  await expect(page.getByRole('region', { name: 'Decision requests', exact: true })).toContainText(
    'Catalog',
  );
  await expect(page).toHaveURL(/view=closed/);
});
