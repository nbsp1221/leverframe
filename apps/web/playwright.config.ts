import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:16721',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx ../reviewer/tests/e2e/web-fixture.ts',
      cwd: '.',
      reuseExistingServer: false,
      timeout: 120_000,
      url: 'http://127.0.0.1:16722/healthz',
    },
    {
      command: 'pnpm exec next dev --hostname 127.0.0.1 --port 16721',
      cwd: '.',
      env: { NODE_ENV: 'development', REVIEWER_INTERNAL_URL: 'http://127.0.0.1:16722' },
      reuseExistingServer: false,
      timeout: 120_000,
      url: 'http://127.0.0.1:16721/en/reviews',
    },
  ],
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
});
