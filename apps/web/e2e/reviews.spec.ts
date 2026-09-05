import { expect, test } from '@playwright/test';

test.describe('review shell fixtures', () => {
  test('redirects root and keeps filters, pagination, detail, and back query', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/en\/reviews$/);
    await page.goto('/en/reviews?fixture=pagination&status=completed');
    await expect(page.getByRole('combobox', { name: 'Filter by status' })).toContainText(
      'Completed',
    );
    await page
      .getByRole('navigation', { name: 'Review pagination' })
      .getByRole('button', { name: '2', exact: true })
      .click();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    await expect(
      page
        .getByRole('navigation', { name: 'Review pagination' })
        .getByRole('button', { name: '2', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await page
      .getByRole('link', { name: /nbsp1221\/leverframe/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/en\/reviews\/\d+/);
    await expect(page.getByRole('heading', { name: /Review run/ })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('fixture')).toBe('pagination');
    await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('completed');
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    await page.getByRole('link', { name: 'Back to reviews' }).click();
    await expect(page).toHaveURL(/\/en\/reviews/);
    await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('fixture')).toBe('pagination');
    await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('completed');
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  });

  test('keeps fixture switching and inbox filters interactive', async ({ page }) => {
    await page.goto('/en/reviews?fixture=default');

    await page.getByRole('combobox', { name: 'Fixture scenario' }).selectOption('degraded');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('fixture')).toBe('degraded');
    await expect(page.getByText('A dependency needs attention.').first()).toBeVisible();

    await page.goto('/en/reviews?fixture=default');
    const filters = page.getByRole('button', { name: 'Filters', exact: true });
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await filters.click();
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Filter by status' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by evaluation' })).toBeVisible();

    await page.getByRole('button', { name: 'Needs evaluation', exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('evaluation'))
      .toBe('needs_evaluation');
  });

  test('completed review prioritizes result and human judgment before diagnostics', async ({
    page,
  }) => {
    await page.goto('/en/reviews/241?fixture=completed-multiple-findings');

    await expect(page.getByText('At a glance', { exact: true })).toBeVisible();
    await expect(
      page.getByText('The reviewer completed the persisted fixture summary.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What to review' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Evaluate', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('radio', { name: 'This is valid', exact: true })).toHaveCount(0);

    const evidence = page.getByRole('button', { name: 'View evidence' }).first();
    await expect(evidence).toHaveAttribute('aria-expanded', 'false');

    const diagnostics = page.getByRole('button', { name: 'Execution details' });
    await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Prompt version', { exact: true })).toBeHidden();

    await diagnostics.click();
    await expect(diagnostics).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Prompt version', { exact: true })).toBeVisible();
    await expect(page.getByText('Base SHA', { exact: true })).toBeHidden();
    const provenance = page.getByRole('button', { name: 'Provenance', exact: true });
    await expect(provenance).toHaveAttribute('aria-expanded', 'false');
    await provenance.click();
    await expect(page.getByText('Base SHA', { exact: true })).toBeVisible();
    await expect(page.getByText('Execution trace', { exact: true })).toBeVisible();
  });

  test('clean completed review hides an empty findings section', async ({ page }) => {
    await page.goto('/en/reviews/235?fixture=completed-zero-findings');
    await expect(page.getByText('At a glance', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What to review' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Files and tests' })).toBeVisible();
  });

  test('expanded finding surfaces stay in the reading flow', async ({ page }) => {
    await page.goto('/en/reviews/241?fixture=completed-multiple-findings');
    const finding = page.locator('article').first();
    const evidence = finding.getByRole('button', { name: 'View evidence' });
    const evaluate = finding.getByRole('button', { name: 'Evaluate', exact: true });

    await evidence.click();
    await expect(
      finding.getByText('Evidence excerpt for finding 1.', { exact: true }),
    ).toBeVisible();
    let evidenceBox = await evidence.boundingBox();
    let evaluateBox = await evaluate.boundingBox();
    if (!evidenceBox || !evaluateBox) {
      throw new Error('finding actions must be measurable');
    }
    expect(Math.abs(evidenceBox.y - evaluateBox.y)).toBeLessThan(8);

    await evaluate.click();
    await expect(finding.getByRole('radio', { name: 'This is valid', exact: true })).toBeVisible();
    evidenceBox = await evidence.boundingBox();
    evaluateBox = await evaluate.boundingBox();
    if (!evidenceBox || !evaluateBox) {
      throw new Error('expanded finding actions must be measurable');
    }
    expect(Math.abs(evidenceBox.y - evaluateBox.y)).toBeLessThan(8);
  });

  test('terminal review without a trace does not look like it is still loading', async ({
    page,
  }) => {
    await page.route('**/api/v1/reviews/231/execution', async (route) => {
      await route.fulfill({
        json: {
          review_id: 231,
          available: false,
          unavailable_reason: 'trace unavailable',
          attempt: 1,
          status: 'cancelled',
          stage: 'cancelled',
          started_at: null,
          process_heartbeat_at: null,
          last_activity_at: null,
          last_sequence: 0,
          trace_truncated: false,
          current_command: null,
          events: [],
        },
      });
    });

    await page.goto('/en/reviews/231?fixture=cancelled');

    await expect(page.getByText('Run ended', { exact: true })).toBeVisible();
    await expect(page.getByText('Loading activity', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('This run did not capture a trace or has not started yet.', { exact: true }),
    ).toBeVisible();
  });

  test('persists theme and switches locale while retaining fixture query', async ({ page }) => {
    await page.goto('/en/reviews?fixture=completed-multiple-findings');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Korean' }).click();
    await expect(page).toHaveURL(/\/ko\/reviews\?fixture=completed-multiple-findings/);
  });

  test('saves, updates, withdraws, and shows evaluation history', async ({ page }) => {
    await page.goto('/en/reviews/241?fixture=evaluation-history');
    let nextId = 3;
    const previousIds: Array<number | null> = [];
    await page.route('**/api/v1/reviews/241/evaluation', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as {
        expected_previous_id: number | null;
        verdict?: string;
      };
      previousIds.push(body.expected_previous_id);
      if (request.method() === 'PUT') {
        const revision = {
          id: nextId++,
          target_type: 'review',
          finding_fingerprint: null,
          verdict: body?.verdict ?? 'useful',
          rationale: 'browser rationale',
          source: 'manual',
          action: 'set',
          supersedes_id: body.expected_previous_id,
          created_at: new Date().toISOString(),
        };
        await route.fulfill({ json: { revision, current: revision } });
      } else {
        const revision = {
          id: nextId++,
          target_type: 'review',
          finding_fingerprint: null,
          verdict: null,
          rationale: null,
          source: 'manual',
          action: 'withdraw',
          supersedes_id: body.expected_previous_id,
          created_at: new Date().toISOString(),
        };
        await route.fulfill({ json: { revision, current: null } });
      }
    });
    const reviewEvaluation = page.getByRole('complementary', { name: 'Review evaluation' });
    await reviewEvaluation.getByRole('radio', { name: 'Helpful', exact: true }).click();
    await reviewEvaluation.getByRole('textbox', { name: 'Rationale' }).fill('browser rationale');
    await reviewEvaluation.getByRole('button', { name: 'Save evaluation' }).click();
    await expect(reviewEvaluation.getByRole('status')).toContainText('Evaluation saved');
    await reviewEvaluation.getByRole('radio', { name: 'Could be better', exact: true }).click();
    await reviewEvaluation.getByRole('button', { name: 'Save evaluation' }).click();
    await expect(reviewEvaluation.getByRole('status')).toContainText('Evaluation saved');
    await reviewEvaluation.getByRole('button', { name: 'Withdraw' }).click();
    await expect(reviewEvaluation.getByRole('status')).toContainText('Evaluation withdrawn');
    expect(previousIds).toEqual([2, 3, 4]);
    await reviewEvaluation.getByRole('button', { name: 'View history' }).click();
    await expect(reviewEvaluation.getByText('Withdraw').last()).toBeVisible();
  });

  test('retains a draft after evaluation conflict', async ({ page }) => {
    await page.goto('/en/reviews/241?fixture=not-evaluated');
    await page.route('**/api/v1/reviews/241/evaluation', (route) =>
      route.fulfill({ status: 409, json: { error: 'stale' } }),
    );
    const reviewEvaluation = page.getByRole('complementary', { name: 'Review evaluation' });
    await reviewEvaluation.getByRole('radio', { name: 'Helpful', exact: true }).click();
    const rationale = reviewEvaluation.getByRole('textbox', { name: 'Rationale' });
    await rationale.fill('keep this draft');
    await reviewEvaluation.getByRole('button', { name: 'Save evaluation' }).click();
    await expect(reviewEvaluation.getByText('This evaluation changed elsewhere')).toBeVisible();
    await expect(rationale).toHaveValue('keep this draft');
  });

  test('opens bounded code context in each explicit state', async ({ page }) => {
    for (const [scenario, expected] of [
      ['context-available', 'const boundedFixtureContext'],
      ['context-unavailable', 'Context unavailable'],
      ['context-error', 'Context error'],
    ] as const) {
      await page.goto(`/en/reviews/241?fixture=${scenario}`);
      await page.getByRole('button', { name: 'View evidence' }).first().click();
      await page.getByRole('button', { name: 'Load context' }).first().click();
      await expect(page.getByText(expected).first()).toBeVisible();
    }
  });

  test('supports mobile sidebar navigation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only navigation behavior');
    await page.goto('/en/reviews?fixture=default');
    await page.getByRole('button', { name: 'Open navigation' }).tap();
    await expect(
      page.getByRole('dialog').getByRole('link', { name: 'Code Review Bot' }),
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('link', { name: 'Code Review Bot' }).tap();
    await page.goto('/en/reviews?fixture=evaluation-history');
    await page
      .getByRole('link', { name: /nbsp1221\/leverframe/ })
      .first()
      .tap();
    await expect(page).toHaveURL(/\/en\/reviews\/241/);
    let nextId = 3;
    await page.route('**/api/v1/reviews/241/evaluation', async (route) => {
      const body = route.request().postDataJSON() as {
        expected_previous_id: number;
        rationale?: string;
        verdict: string;
      };
      const revision = {
        id: nextId++,
        target_type: 'review',
        finding_fingerprint: null,
        verdict: body.verdict,
        rationale: body.rationale ?? null,
        source: 'manual',
        action: 'set',
        supersedes_id: body.expected_previous_id,
        created_at: new Date().toISOString(),
      };
      await route.fulfill({ json: { revision, current: revision } });
    });
    const reviewEvaluation = page.getByRole('complementary', { name: 'Review evaluation' });
    const helpful = reviewEvaluation.getByRole('radio', { name: 'Helpful', exact: true });
    await helpful.focus();
    await page.keyboard.press('Enter');
    await expect(helpful).toHaveAttribute('aria-checked', 'true');
    await reviewEvaluation
      .getByRole('textbox', { name: 'Rationale' })
      .fill('mobile keyboard review');
    await reviewEvaluation.getByRole('button', { name: 'Save evaluation' }).tap();
    await expect(reviewEvaluation.getByRole('status')).toContainText('Evaluation saved');
    await reviewEvaluation.getByRole('button', { name: 'View history' }).tap();
    await expect(
      reviewEvaluation.getByText('· mobile keyboard review', { exact: true }),
    ).toBeVisible();
  });
});
