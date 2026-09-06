import type {
  DependencyStatus,
  EvaluationsResponse,
  ReviewDetail,
  ReviewListItem,
  ReviewListResponse,
} from '@repo/contracts';

export const fixtureScenarios = [
  'default',
  'healthy',
  'degraded',
  'unavailable',
  'loading',
  'empty-history',
  'filtered-empty',
  'list-error',
  'pagination',
  'running',
  'queued',
  'cancelled',
  'unknown',
  'completed-zero-findings',
  'completed-multiple-findings',
  'failed',
  'superseded',
  'missing-artifact',
  'incomplete-coverage',
  'not-evaluated',
  'review-level-only',
  'partial-finding-evaluation',
  'all-findings-evaluated',
  'evaluation-history',
  'saving-evaluation',
  'evaluation-save-failure',
  'context-available',
  'context-unavailable',
  'context-loading',
  'context-error',
  'stress',
  'stress-many-findings',
  'finding-open',
  'finding-fixed',
  'finding-still-present',
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number];
export type FixtureListState = 'ready' | 'loading' | 'empty' | 'filtered-empty' | 'error';

export type FixtureState = {
  scenario: FixtureScenario;
  listState: FixtureListState;
  health: {
    overall: DependencyStatus;
    observedAt: string;
    dependencies: Record<'api' | 'worker' | 'sandbox' | 'github', DependencyStatus>;
  };
  reviews: ReviewListItem[];
  activeReview?: ReviewListItem;
  fixtureOnly: true;
};

export type FixtureListQuery = {
  page?: number | undefined;
  query?: string | undefined;
  status?: string | undefined;
  evaluation?: string | undefined;
};

const observedAt = '2026-08-18T09:00:00.000Z';

function review(overrides: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    id: 241,
    repository: 'nbsp1221/leverframe',
    pull_request_number: 118,
    pull_request_title: 'Harden review worker lifecycle',
    head_sha: 'd1ab712',
    base_sha: 'b9f35d2',
    status: 'completed',
    model: 'GPT-5.6 Luna',
    reasoning: 'xhigh',
    findings_count: 3,
    highest_severity: 'high',
    review_evaluation: null,
    evaluated_findings: 0,
    total_findings: 3,
    created_at: observedAt,
    started_at: observedAt,
    completed_at: observedAt,
    duration_ms: 131000,
    ...overrides,
  };
}

function standardReviews(): ReviewListItem[] {
  return [
    review(),
    review({
      id: 240,
      pull_request_number: 119,
      pull_request_title: 'Add review observability schema',
      status: 'running',
      findings_count: null,
      highest_severity: null,
      completed_at: null,
      duration_ms: 62000,
      total_findings: 0,
    }),
    review({
      id: 239,
      pull_request_number: 117,
      pull_request_title: 'Refactor publication pipeline',
      status: 'superseded',
      findings_count: 0,
      highest_severity: null,
      total_findings: 0,
      duration_ms: 38000,
    }),
    review({
      id: 238,
      pull_request_number: 116,
      pull_request_title: 'Validate prompt resources at startup',
      findings_count: 2,
      highest_severity: 'medium',
      total_findings: 2,
      duration_ms: 103000,
    }),
    review({
      id: 237,
      repository: 'nbsp1221/infra',
      pull_request_number: 42,
      pull_request_title: 'Update review sandbox image',
      status: 'failed',
      findings_count: 0,
      highest_severity: null,
      total_findings: 0,
      completed_at: null,
      duration_ms: 49000,
    }),
  ];
}

function paginationReviews(): ReviewListItem[] {
  return Array.from({ length: 24 }, (_, index) =>
    review({
      id: 241 - index,
      pull_request_number: 118 - index,
      pull_request_title: `Review run ${241 - index}: lifecycle verification`,
      total_findings: index % 4,
      findings_count: index % 4,
      highest_severity: index % 4 === 0 ? null : index % 2 === 0 ? 'medium' : 'high',
    }),
  );
}

function health(overall: DependencyStatus): FixtureState['health'] {
  return {
    overall,
    observedAt,
    dependencies: {
      api: overall,
      worker: overall === 'unavailable' ? 'unavailable' : overall,
      sandbox: overall === 'degraded' ? 'degraded' : overall,
      github: overall,
    },
  };
}

export function createFixture(scenario: FixtureScenario = 'default'): FixtureState {
  const state: FixtureState = {
    scenario,
    listState: 'ready',
    health: health('healthy'),
    reviews: standardReviews(),
    fixtureOnly: true,
  };

  if (scenario === 'degraded') {
    state.health = health('degraded');
  }
  if (scenario === 'unavailable') {
    state.health = health('unavailable');
  }
  if (scenario === 'loading') {
    state.listState = 'loading';
  }
  if (scenario === 'empty-history') {
    state.listState = 'empty';
    state.reviews = [];
  }
  if (scenario === 'filtered-empty') {
    state.listState = 'filtered-empty';
    state.reviews = [];
  }
  if (scenario === 'list-error') {
    state.listState = 'error';
  }
  if (scenario === 'pagination') {
    state.reviews = paginationReviews();
  }
  if (scenario === 'running') {
    state.activeReview = review({
      id: 240,
      status: 'running',
      findings_count: null,
      highest_severity: null,
      completed_at: null,
      total_findings: 0,
    });
  }
  if (scenario === 'queued' || scenario === 'cancelled' || scenario === 'unknown') {
    state.activeReview = review({
      id: scenario === 'queued' ? 232 : scenario === 'cancelled' ? 231 : 230,
      status: scenario,
      findings_count: null,
      highest_severity: null,
      completed_at: null,
      total_findings: 0,
    });
  }
  if (scenario === 'completed-zero-findings') {
    state.activeReview = review({
      id: 235,
      findings_count: 0,
      highest_severity: null,
      total_findings: 0,
    });
  }
  if (scenario === 'completed-multiple-findings') {
    state.activeReview = review();
  }
  if (scenario === 'failed') {
    state.activeReview = review({
      id: 237,
      status: 'failed',
      findings_count: 0,
      highest_severity: null,
      completed_at: null,
      total_findings: 0,
    });
  }
  if (scenario === 'superseded') {
    state.activeReview = review({
      id: 239,
      status: 'superseded',
      findings_count: 0,
      highest_severity: null,
      total_findings: 0,
    });
  }
  if (scenario === 'missing-artifact' || scenario === 'incomplete-coverage') {
    state.activeReview = review({
      id: 234,
      findings_count: scenario === 'incomplete-coverage' ? 1 : null,
      total_findings: scenario === 'incomplete-coverage' ? 1 : 0,
    });
  }
  if (
    scenario === 'not-evaluated' ||
    scenario === 'review-level-only' ||
    scenario === 'partial-finding-evaluation' ||
    scenario === 'all-findings-evaluated' ||
    scenario === 'evaluation-history' ||
    scenario === 'saving-evaluation' ||
    scenario === 'evaluation-save-failure' ||
    scenario === 'context-available' ||
    scenario === 'context-unavailable' ||
    scenario === 'context-loading' ||
    scenario === 'context-error'
  ) {
    state.activeReview = review({
      review_evaluation:
        scenario === 'review-level-only' ||
        scenario === 'partial-finding-evaluation' ||
        scenario === 'all-findings-evaluated' ||
        scenario === 'evaluation-history'
          ? 'mixed'
          : null,
      evaluated_findings:
        scenario === 'partial-finding-evaluation'
          ? 1
          : scenario === 'all-findings-evaluated'
            ? 3
            : 0,
    });
  }
  if (scenario === 'stress') {
    state.activeReview = review({
      repository: 'company/platform-infrastructure-and-observability',
      pull_request_title:
        'A deliberately long pull request title that should remain readable without overflowing the review shell on narrow screens',
      findings_count: 3,
      total_findings: 3,
    });
  }
  if (scenario === 'stress-many-findings') {
    state.activeReview = review({
      pull_request_title: 'Stress review with many findings across severity levels',
      findings_count: 10,
      total_findings: 10,
      highest_severity: 'high',
    });
  }
  if (
    scenario === 'finding-open' ||
    scenario === 'finding-fixed' ||
    scenario === 'finding-still-present'
  ) {
    state.activeReview = review({ id: 229, findings_count: 2, total_findings: 2 });
  }

  return state;
}

export function isFixtureScenario(value: string | undefined): value is FixtureScenario {
  return fixtureScenarios.includes(value as FixtureScenario);
}

export function isFixtureControlEnabled(environment: string | undefined): boolean {
  return environment !== 'production';
}

export function fixtureListResponse(
  state: FixtureState,
  query: FixtureListQuery = {},
): ReviewListResponse {
  const allReviews = state.activeReview
    ? [state.activeReview, ...state.reviews.filter((item) => item.id !== state.activeReview?.id)]
    : state.reviews;
  const search = query.query?.trim().toLowerCase();
  const filtered = allReviews.filter((item) => {
    const haystack =
      `${item.repository} ${item.pull_request_number} ${item.pull_request_title ?? ''}`.toLowerCase();
    const matchesQuery = !search || haystack.includes(search);
    const matchesStatus = !query.status || query.status === 'all' || item.status === query.status;
    const matchesEvaluation =
      !query.evaluation ||
      query.evaluation === 'all' ||
      (query.evaluation === 'evaluated'
        ? item.review_evaluation !== null
        : item.status === 'completed' && item.review_evaluation === null);
    return matchesQuery && matchesStatus && matchesEvaluation;
  });
  const page = Math.max(1, query.page ?? 1);
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / 20);
  return {
    items: filtered.slice((page - 1) * 20, page * 20),
    page,
    page_size: 20,
    total_items: totalItems,
    total_pages: totalPages,
  };
}

export function fixtureDetailResponse(
  state: FixtureState,
  reviewId: number,
): ReviewDetail | undefined {
  const item =
    state.activeReview?.id === reviewId
      ? state.activeReview
      : state.reviews.find((candidate) => candidate.id === reviewId);
  if (!item) {
    return undefined;
  }
  const artifactAvailable = item.status === 'completed' && state.scenario !== 'missing-artifact';
  const findings = artifactAvailable
    ? Array.from({ length: item.findings_count ?? 0 }, (_, index) => ({
        fingerprint: (index + 1).toString(16).padStart(16, '0'),
        severity:
          state.scenario === 'stress-many-findings'
            ? index === 0
              ? 'high'
              : index < 4
                ? 'medium'
                : 'low'
            : index === 0
              ? (item.highest_severity ?? 'medium')
              : 'low',
        confidence: 'high' as const,
        title: `Finding ${index + 1}: verify the review boundary`,
        explanation: 'The persisted finding explanation is shown without translation.',
        suggested_action: 'Confirm the boundary and add a regression test.',
        evidence: `Evidence excerpt for finding ${index + 1}.`,
        file: `src/review/finding-${index + 1}.ts`,
        line: 40 + index,
        state:
          state.scenario === 'finding-fixed'
            ? ('fixed' as const)
            : state.scenario === 'finding-still-present'
              ? ('still_present' as const)
              : ('open' as const),
        thread_resolution:
          state.scenario === 'finding-fixed'
            ? {
                state: 'resolved' as const,
                resolved_at: '2026-08-23T00:00:00.000Z',
                resolved_head_sha: item.head_sha,
                last_error: null,
              }
            : null,
        evaluation:
          item.evaluated_findings > index && item.review_evaluation !== null
            ? ('valid' as const)
            : null,
      }))
    : [];
  const reviewEvaluation = item.review_evaluation
    ? {
        id: 1,
        target_type: 'review' as const,
        finding_fingerprint: null,
        verdict: item.review_evaluation,
        rationale: 'Fixture evaluation rationale.',
        source: 'manual' as const,
        action: 'set' as const,
        supersedes_id: null,
        created_at: observedAt,
      }
    : null;
  const coverage = artifactAvailable
    ? {
        changed_files: ['src/review/worker.ts', 'src/review/history.ts'],
        reviewed_files: ['src/review/worker.ts'],
        omitted_files: state.scenario === 'incomplete-coverage' ? ['src/github/client.ts'] : [],
        complete: state.scenario !== 'incomplete-coverage',
      }
    : null;
  return {
    id: item.id,
    repository: item.repository,
    pull_request_number: item.pull_request_number,
    pull_request_title: item.pull_request_title,
    head_sha: item.head_sha,
    base_sha: item.base_sha,
    installation_id: 42,
    action: 'opened',
    status: item.status,
    attempt: 1,
    model: item.model,
    reasoning: item.reasoning,
    prompt_version: 'review-v1',
    prompt_hash: 'prompt-fixture-hash',
    schema_version: 'review-schema-v1',
    schema_hash: 'schema-fixture-hash',
    created_at: item.created_at,
    review_started_at: item.started_at,
    review_completed_at: item.completed_at,
    publication_started_at: item.completed_at,
    published_at: item.status === 'completed' ? item.completed_at : null,
    published_review_id: item.status === 'completed' ? item.id + 1000 : null,
    error_code: item.status === 'failed' ? 'SANDBOX_UNAVAILABLE' : null,
    error_excerpt: item.status === 'failed' ? 'Sandbox health check timed out.' : null,
    superseded_by_job_id: item.status === 'superseded' ? item.id + 1 : null,
    artifact: {
      available: artifactAvailable,
      content_hash: artifactAvailable ? 'artifact-fixture-hash' : null,
      unavailable_reason: artifactAvailable
        ? null
        : item.status === 'completed'
          ? 'MISSING'
          : 'NOT_READY',
      summary: artifactAvailable ? 'The reviewer completed the persisted fixture summary.' : null,
      findings,
      coverage,
      limitations:
        state.scenario === 'incomplete-coverage' ? ['Some changed files were omitted.'] : [],
      tests_run: artifactAvailable
        ? [{ command: 'pnpm test', status: 'passed' as const, evidence: 'Fixture test evidence.' }]
        : [],
    },
    review_evaluation: reviewEvaluation,
  };
}

export function fixtureEvaluationsResponse(
  state: FixtureState,
  reviewId: number,
): EvaluationsResponse | undefined {
  const detail = fixtureDetailResponse(state, reviewId);
  if (!detail) {
    return undefined;
  }
  const reviewCurrent = detail.review_evaluation
    ? {
        id: state.scenario === 'evaluation-history' ? 2 : 1,
        target_type: 'review' as const,
        finding_fingerprint: null,
        verdict: detail.review_evaluation.verdict,
        rationale: 'Fixture evaluation rationale.',
        source: 'manual' as const,
        action: 'set' as const,
        supersedes_id: state.scenario === 'evaluation-history' ? 1 : null,
        created_at: observedAt,
      }
    : null;
  const reviewHistory =
    state.scenario === 'evaluation-history'
      ? [
          reviewCurrent!,
          { ...reviewCurrent!, id: 1, verdict: 'useful' as const, supersedes_id: null },
        ]
      : reviewCurrent
        ? [reviewCurrent]
        : [];
  const findings = Object.fromEntries(
    detail.artifact.findings.map((finding, index) => {
      const evaluated = finding.evaluation !== null;
      const current = evaluated
        ? {
            id: 10 + index,
            target_type: 'finding' as const,
            finding_fingerprint: finding.fingerprint,
            verdict: finding.evaluation,
            rationale: 'Fixture finding rationale.',
            source: 'manual' as const,
            action: 'set' as const,
            supersedes_id: null,
            created_at: observedAt,
          }
        : null;
      return [
        finding.fingerprint,
        { current, history: current ? [current] : [], truncated: false },
      ];
    }),
  );
  return {
    review: { current: reviewCurrent, history: reviewHistory, truncated: false },
    findings,
  };
}
