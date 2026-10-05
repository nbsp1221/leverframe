import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('onboarding connects a computer without asking for a project or session', async ({ page }) => {
  let connected = false;
  const item = {
    id: 'computer-one',
    name: 'Work computer',
    hostname: 'workstation',
    status: 'online',
    lastSeenAt: new Date().toISOString(),
    health: { codex: 'ready', skill: 'installed' },
    sessionCount: 0,
    lastQuestionAt: null,
    lastDeliveredAt: null,
  };
  await page.route('**/api/v1/connectors', (route) =>
    route.fulfill({ json: { items: connected ? [item] : [] } }),
  );
  await page.route('**/api/v1/connectors/pairings', (route) =>
    route.fulfill({
      json: {
        id: 'pair',
        code: 'example-single-use-registration-code',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/v1/connectors/pairings/pair', (route) =>
    route.fulfill({
      json: {
        status: connected ? 'connected' : 'waiting',
        connectorId: connected ? item.id : null,
      },
    }),
  );
  await page.goto('/en/connections');
  await expect(
    page.getByText('Connect the computer where you use Codex', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connect computer', exact: true }).first().click();
  const command = page.getByRole('textbox', { name: 'Install and connect command' });
  await expect(command).toHaveValue(/download\/install\.sh/);
  await expect(command).toHaveValue(/'en'$/);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  connected = true;
  await expect(
    page.getByRole('heading', { name: 'Your computer is connected', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Not used yet', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Answer delivery to original conversation verified', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message to send in Codex' })).toHaveValue(
    /leverframe-ask/,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('a failed disconnect stays visible across health refreshes and can be retried', async ({
  page,
}) => {
  let fail = true;
  let revoked = false;
  const item = {
    id: 'computer-one',
    name: 'Work computer',
    hostname: 'workstation',
    status: 'offline',
    lastSeenAt: null,
    health: { codex: 'unavailable', skill: 'installed' },
    sessionCount: 1,
    lastQuestionAt: new Date().toISOString(),
    lastDeliveredAt: null,
  };
  await page.route('**/api/v1/connectors', (route) =>
    route.fulfill({ json: { items: [{ ...item, status: revoked ? 'revoked' : 'offline' }] } }),
  );
  await page.route('**/api/v1/connectors/computer-one/revoke', (route) => {
    if (!fail) {
      revoked = true;
    }
    return route.fulfill({
      status: fail ? 503 : 200,
      json: fail ? { error: 'unavailable' } : { ok: true },
    });
  });
  await page.goto('/en/connections');
  await expect(
    page.getByText('Answers are saved while waiting for reconnection', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByText('Disconnect this computer?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect computer', exact: true }).click();
  await expect(page.getByText('Could not check connections', { exact: true })).toBeVisible();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/connectors') && response.ok(),
  );
  await expect(page.getByText('Could not check connections', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Disconnect computer', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Work computer', exact: true })).toHaveCount(0);
  await expect(page.getByText('Disconnected computers', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not check connections', { exact: true })).toHaveCount(0);
});
