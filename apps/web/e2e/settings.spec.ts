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

test('settings has a category index, replaces work navigation, and preserves old connection links', async ({
  page,
}, testInfo) => {
  await page.route('**/api/v1/connectors', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/en/reviews?fixture=default');
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
  const mainRect = await primary.boundingBox();
  const footerRect = await footer.boundingBox();
  expect(footerRect!.y).toBeGreaterThan(mainRect!.y + mainRect!.height - 1);
  await footer.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/settings\?/);
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('aside:visible')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  } else {
    await expect(page.locator('aside:visible')).toHaveCount(1);
    await expect(
      page.locator('aside').getByRole('link', { name: 'Requests', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('aside nav [data-sidebar="menu-button"]')).toHaveCount(2);
  }
  await page
    .getByRole('navigation', { name: 'Settings categories', exact: true })
    .getByRole('link', { name: /^Code Review Bot/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Code review bot', exact: true })).toBeVisible();
  await page.goto('/en/connections');
  await expect(page).toHaveURL(/\/en\/settings\/connections/);
  await expect(
    page.getByRole('heading', { name: 'Connected computers', exact: true }),
  ).toBeVisible();
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
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('link', { name: 'Back to settings', exact: true }).click();
  }
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
  await expect(page).toHaveURL(/\/en\/settings\?/);
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('link', { name: /^Code Review Bot/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Code review bot', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('link', { name: 'Back to settings', exact: true }).click();
  }
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
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('link', { name: 'Back to settings', exact: true }).click();
  }
  await page.getByRole('link', { name: 'Back to work' }).click();
  await expect(page).toHaveURL(new RegExp(`request=${item.id}`));
  issue = 'busy';
  await page.reload();
  await expect(page.locator('article').getByRole('link', { name: 'Check connection' })).toHaveCount(
    0,
  );
});
