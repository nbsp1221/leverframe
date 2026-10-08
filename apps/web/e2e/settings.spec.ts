import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { decisionSchema } from '@repo/contracts/decisions';

const computer = {
  id: 'test-computer',
  name: 'Work computer',
  hostname: 'workstation',
  status: 'offline',
  lastSeenAt: null,
  health: { codex: 'unavailable', skill: 'installed' },
  sessionCount: 1,
  lastQuestionAt: null,
  lastDeliveredAt: null,
};

test('settings is separate from work navigation and old links reach the same page', async ({
  page,
}, testInfo) => {
  await page.route('**/api/v1/connectors', (route) => route.fulfill({ json: { items: [] } }));
  for (const path of ['/en/connections', '/en/settings']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/en\/settings\/connections/);
    await expect(
      page.getByRole('heading', { name: 'Connected computers', exact: true }),
    ).toBeVisible();
  }
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const primary = page.locator('[data-sidebar="content"]:visible');
  const footer = page.locator('[data-sidebar="footer"]:visible');
  await expect(primary.locator('[data-sidebar="menu-button"]')).toHaveCount(3);
  await expect(primary.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(primary.getByRole('link', { name: 'Connected computers', exact: true })).toHaveCount(
    0,
  );
  await expect(footer.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const mainRect = await primary.boundingBox();
  const footerRect = await footer.boundingBox();
  expect(footerRect!.y).toBeGreaterThan(mainRect!.y + mainRect!.height - 1);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});

test('first connection guidance distinguishes loading, errors, and an offline registered computer', async ({
  page,
}) => {
  await page.route('**/api/v1/decisions', (route) => route.fulfill({ json: { items: [] } }));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let state: 'loading' | 'error' | 'empty' | 'offline' = 'loading';
  await page.route('**/api/v1/connectors', async (route) => {
    if (state === 'loading') {
      await waiting;
    }
    await route.fulfill({
      status: state === 'error' ? 503 : 200,
      json:
        state === 'error'
          ? { error: 'unavailable' }
          : { items: state === 'offline' ? [computer] : [] },
    });
  });
  await page.goto('/en/decisions');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await expect(page.getByText('Receive questions from Codex here')).toHaveCount(0);
  state = 'error';
  release();
  await expect(page.getByText('Connection status is unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Receive questions from Codex here')).toHaveCount(0);
  state = 'empty';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Receive questions from Codex here', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Connect computer', exact: true }).click();
  await expect(page).toHaveURL(/settings\/connections/);
  state = 'offline';
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await expect(page.getByText('Receive questions from Codex here')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Connected computers', exact: true })).toHaveCount(0);
});

test('settings round trip preserves a selected request, filters, and unsent answer', async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get('/api/v1/decisions/dr-101');
  const item = decisionSchema.parse(await response.json());
  const decision = {
    ...item,
    id: 'settings-draft',
    status: 'awaiting_answer',
    revision: 0,
    snoozedUntil: null,
    answers: [],
    events: [],
  };
  await page.route('**/api/v1/decisions', (route) =>
    route.fulfill({ json: { items: [decision] } }),
  );
  await page.route('**/api/v1/connectors', (route) =>
    route.fulfill({ json: { items: [computer] } }),
  );
  const path = '/en/decisions?request=settings-draft&view=attention&q=kept-filter';
  await page.goto(path);
  const input = page.getByLabel('Your view or additional conditions');
  await input.fill('Keep this condition while I check settings.');
  const selected = page.locator('article').getByRole('button', { name: /AI recommended/ });
  await selected.click();
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page
    .locator('[data-sidebar="footer"]:visible')
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await expect(page).toHaveURL(/settings\/connections/);
  await expect(
    page.getByRole('heading', { name: 'Connected computers', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('request=settings-draft&view=attention&q=kept-filter'));
  await expect(input).toHaveValue('Keep this condition while I check settings.');
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
});

test('only an offline delivery offers connection settings and keeps the saved answer', async ({
  page,
  request,
}) => {
  const response = await request.get('/api/v1/decisions/dr-103');
  const item = decisionSchema.parse(await response.json());
  let issue = 'offline';
  await page.route('**/api/v1/decisions', (route) =>
    route.fulfill({
      json: { items: [{ ...item, status: 'delivery_failed', deliveryIssue: issue }] },
    }),
  );
  await page.goto(`/en/decisions?request=${item.id}&view=progress`);
  await expect(
    page.locator('article').getByRole('link', { name: 'Check connection' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: /Your last response/ })).toBeVisible();
  await page.getByRole('link', { name: 'Check connection' }).click();
  await page.getByRole('link', { name: 'Back to work' }).click();
  await expect(page).toHaveURL(new RegExp(`request=${item.id}`));
  issue = 'busy';
  await page.reload();
  await expect(page.locator('article').getByRole('link', { name: 'Check connection' })).toHaveCount(
    0,
  );
});
