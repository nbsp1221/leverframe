# Automatic review thread resolution

Status: Implemented behind a disabled feature flag

Decision: No-go for installation-token automatic resolution

Last reviewed: 2026-08-23

## Summary

Leverframe should automatically resolve one of its GitHub inline review threads when a successful later review explicitly verifies that the corresponding finding is fixed. The existing review agent should make both prior-finding status judgments and new-finding discoveries in one sandbox run. A separate deterministic publication component should validate those judgments, associate findings with GitHub review threads, optionally post concise evidence, and call GitHub's `resolveReviewThread` GraphQL mutation.

This is a natural extension of the current architecture because Leverframe already carries prior findings into incremental reviews, assigns stable fingerprints, accepts `fixed` and `still_present` finding updates, and persists the reconciled state. The missing capability is a durable association between each published inline finding and its GitHub thread, followed by an idempotent resolution side effect.

The implementation is present behind `REVIEW_RESOLVE_FIXED_THREADS=false`, but it must not be enabled with the current installation-token authentication model. The live capability gate proved that the installation token can publish and discover a marked Leverframe thread but GitHub reports `viewerCanResolve: false` even though the installation has `pull_requests: write`.

## Live capability result

The capability spike ran on 2026-08-23 against only the designated private repository `nbsp1221/skillpin-private-e2e-20260718` and its existing open PR `#1`. Privacy and PR state were confirmed immediately before each mutation.

- GitHub App installation `154194448` had `pull_requests: write`, `checks: write`, `contents: read`, `issues: read`, and `metadata: read`.
- The implementation published review `5002524379` with marker `<!-- leverframe:finding:e59853ea8e734f3c:job:1787492799742 -->` and associated it uniquely with thread `PRRT_kwDOTcbuks6bfpbe`.
- The installation-scoped GraphQL query returned `viewerCanResolve: false`; `GitHubAppClient.resolveFindingThread` correctly stopped before posting a reply or calling `resolveReviewThread`.
- The repository owner resolved that exact QA thread for cleanup. A second call through the installation-scoped implementation returned `{ "alreadyResolved": true }` without another mutation.
- No new PR was created and no other repository was used.

This is a release blocker, not an implementation defect. GitHub's schema exposes the mutation to installation tokens, but the live authorization result shows that repository permission alone does not make the App viewer eligible to resolve this conversation. The next architecture decision is whether to add an explicitly authorized GitHub App user-to-server token or retain manual thread resolution. That authentication expansion requires a separate approved design because Leverframe currently stores no GitHub user client secret or OAuth grant.

## Problem

Leverframe publishes actionable findings as inline GitHub review comments. When an author pushes a later commit that fixes a finding, Leverframe runs another incremental review and can already record that finding as `FIXED`, but the original GitHub conversation remains unresolved. The stale open thread creates manual cleanup, can obscure genuinely outstanding feedback, and may block merging when a repository requires all review conversations to be resolved.

The product needs to close that loop without resolving comments merely because their original lines changed or because GitHub marked them outdated.

## Goals

- Resolve a Leverframe-authored inline review thread only after a successful later review explicitly verifies the finding as fixed.
- Preserve evidence for why the thread was resolved and the exact head commit that was verified.
- Use one sandbox review run to classify prior findings and discover new findings.
- Keep the AI agent unable to call GitHub or mutate thread state directly.
- Make thread discovery and resolution idempotent across retries, process restarts, ambiguous network failures, and webhook redelivery.
- Never resolve another actor's thread or a thread that cannot be associated unambiguously with a Leverframe finding.
- Preserve the existing cancellation and supersession guarantees so an obsolete review cannot resolve threads on a newer head.
- Expose enough local state to diagnose association and resolution failures.

## Non-goals

- Automatically edit source code to fix findings.
- Resolve general PR issue comments or summary-only findings that have no review thread.
- Resolve all bot comments merely because a command was issued.
- Treat GitHub's `isOutdated` signal as proof that a defect was fixed.
- Automatically unresolve a thread that a human resolved or reopen a historical thread after a regression in the first release.
- Subscribe to `pull_request_review_thread` webhooks in the first release. GitHub remains authoritative and is queried before each mutation.
- Backfill historical marker-free comments automatically.
- Change the review verdict from the existing non-blocking `COMMENT` behavior.

## Product behavior

When a new commit is pushed, Leverframe performs its normal incremental review. The agent receives the prior findings with their fingerprints, inspects the incremental diff and current repository state, and returns both new `findings` and any verified `finding_updates`.

The result is interpreted as follows:

| Agent result                                | Local state                                     | GitHub action                                                                                       |
| ------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Explicit `fixed` update with valid evidence | `FIXED`                                         | Reconcile the associated thread, optionally post resolution evidence, then resolve it               |
| Explicit `still_present` update             | `STILL_PRESENT`                                 | Keep the thread open; do not add a repetitive reply by default                                      |
| No update for a prior finding               | Preserve the prior state                        | No GitHub action                                                                                    |
| Invalid or ambiguous update                 | Reject or ignore according to validation policy | No GitHub action                                                                                    |
| New finding                                 | `OPEN`                                          | Publish a new inline thread when the line is reviewable, otherwise include it in the review summary |

The first release should post a concise reply before resolving so the resolution remains understandable from GitHub without requiring access to the Leverframe UI. The reply format should be deterministic and bounded:

```markdown
✅ Verified as fixed in `abc1234`.

Evidence: The null input is rejected before the database call, and the focused regression test passes.

<!-- leverframe:resolution:0123456789abcdef:job:42 -->
```

The evidence must come from the validated `finding_updates` entry. The renderer must enforce GitHub body limits and must not include secrets, installation tokens, absolute host paths, or raw model event logs.

## Agent architecture decision

Use one review agent, not separate review and resolution agents.

The single sandbox run has the complete context needed to determine whether previous findings remain, whether a fix is valid, and whether the same change introduced a new defect. A second general-purpose agent would repeat repository inspection and tests, increase cost and latency, and create reconciliation problems when the two agents disagree.

The responsibilities still remain separated at the code boundary:

```text
SandboxReviewer
├─ classify prior findings
└─ discover new findings

Review result validation
├─ validate the output schema
├─ validate update fingerprints against prior context
└─ enforce evidence requirements

Finding reconciliation
├─ OPEN
├─ STILL_PRESENT
└─ FIXED

GitHub thread publication
├─ associate inline findings with thread node IDs
├─ post resolution evidence idempotently
└─ resolve eligible threads idempotently
```

A separate verifier agent may be considered later for security-critical or high-severity findings, but it is not required for the semantic design.

## Existing Leverframe support

The current code already provides most of the semantic foundation:

- `SandboxReviewer` includes prior findings and stable fingerprints in incremental review context.
- `review-schema.json` and `reviewResultSchema` accept `finding_updates` with `fixed` or `still_present` status and evidence.
- `findingFingerprint` derives a stable 16-character fingerprint from normalized path and title.
- `ReviewRepository.reconcileFindings` persists `OPEN`, `STILL_PRESENT`, and `FIXED` states.
- `ReviewWorker` guards publication against cancellation, supersession, and changed PR heads.
- `GitHubAppClient.publishReview` uses a hidden review marker to reconcile ambiguous publication failures.
- The GitHub App already requests `pull_requests: write`.

The current publication path stores only the numeric review ID. It does not retain individual review comment IDs or GraphQL thread node IDs, and inline comment bodies do not contain finding fingerprints. These are the primary gaps.

## Market behavior

Automatic resolution is an established code-review product pattern rather than a speculative feature.

- CodeRabbit performs incremental reviews after new commits, documents automatic detection and resolution of implemented suggestions, and also provides `@coderabbitai resolve` as an explicit bulk operation.
- cubic exposes `resolve_threads_when_addressed`, automatically resolves a thread after a later commit addresses the issue, and enables the setting by default for new installations.
- Greptile states that comments resolve when a fix is pushed and also supports IDE/MCP workflows that apply fixes and mark threads resolved.
- GitHub Copilot review comments behave like human review comments and can be manually resolved, but the reviewed GitHub documentation does not promise automatic semantic resolution.
- Gitar describes automatically cleaning up inline comments as issues are addressed.

The useful market distinction is not whether automatic resolution exists, but whether resolution is based on semantic verification rather than line churn. Leverframe should preserve its evidence-first review posture and require an explicit verified `fixed` update.

References:

- [CodeRabbit changelog](https://docs.coderabbit.ai/changelog)
- [CodeRabbit review commands](https://docs.coderabbit.ai/reference/review-commands)
- [cubic AI review settings](https://docs.cubic.dev/ai-review/ai-review-settings)
- [cubic repository configuration](https://docs.cubic.dev/configure/cubic-yaml)
- [Greptile key features](https://www.greptile.com/docs/code-review/key-features)
- [GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
- [Gitar comment management](https://gitar.ai/blog/ai-code-review-without-the-comment-spam)

## GitHub API feasibility

GitHub's GraphQL schema exposes `PullRequest.reviewThreads`, including each thread's node ID, comments, path, line, `isOutdated`, `isResolved`, `viewerCanResolve`, and `viewerCanUnresolve`. It also exposes the `resolveReviewThread` mutation with a required `threadId`.

```graphql
query LeverframeReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isOutdated
          isResolved
          viewerCanResolve
          path
          line
          comments(first: 100) {
            nodes {
              id
              body
              author {
                login
              }
              pullRequestReview {
                fullDatabaseId
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
```

The implementation must paginate thread comments when it searches for a previously accepted resolution reply; the first page is sufficient for the original finding marker but is not an idempotency guarantee for a long conversation.

```graphql
mutation ReplyToLeverframeReviewThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment {
      id
    }
  }
}
```

```graphql
mutation ResolveLeverframeReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
```

The installed Octokit client exposes a GraphQL client on the installation-scoped Octokit instance. Installation access tokens can call GraphQL with the app's repository permissions. GitHub advises testing GraphQL operations because its reference does not publish a complete mutation-to-App-permission table.

The live test disproved the assumption that the current manifest's `pull_requests: write` permission is sufficient for an installation token. The implementation checks `viewerCanResolve` and treats `false` as a permanent, operator-visible failure. GitHub's official guidance remains to test GraphQL operations because the reference does not publish a complete mutation-to-App-permission table.

GitHub documentation:

- [Pull request GraphQL objects and mutations](https://docs.github.com/en/graphql/reference/pulls)
- [GitHub App permission selection](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Resolving pull request conversations](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)
- [`pull_request_review_thread` webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_thread)

## Identity and association design

### Inline marker

Every newly published inline finding must include a hidden marker derived from the existing fingerprint:

```html
<!-- leverframe:finding:0123456789abcdef:job:42 -->
```

The marker must be generated by trusted application code, not by the model. The model result supplies finding fields, while the application calculates the fingerprint and renders the marker.

The marker makes recovery safe when the review creation response is lost, when a process restarts before association is stored, or when the comment's current line becomes outdated. Path and line alone are insufficient because lines move and multiple findings may share a location.

### Persistence

Add a migration for a dedicated publication table rather than placing one thread ID directly on `review_findings`.

```sql
CREATE TABLE github_finding_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  publication_job_id INTEGER NOT NULL REFERENCES review_jobs(id),
  review_database_id TEXT NOT NULL,
  thread_node_id TEXT NOT NULL UNIQUE,
  comment_node_id TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK(resolution_state IN ('OPEN', 'RESOLUTION_PENDING', 'RESOLVED', 'RESOLUTION_FAILED')),
  resolved_by_job_id INTEGER REFERENCES review_jobs(id),
  resolved_head_sha TEXT,
  resolution_evidence TEXT,
  resolution_comment_node_id TEXT,
  resolution_attempts INTEGER NOT NULL DEFAULT 0,
  next_resolution_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(publication_job_id, fingerprint)
);

CREATE INDEX github_finding_threads_target_idx
  ON github_finding_threads(repository, pull_request_number, fingerprint, id DESC);
```

The separate table supports publication history, idempotent reconciliation, and a future recurrence policy. The stored `resolution_evidence` should be bounded and redacted using the same failure-output principles used elsewhere in the repository.

### Association algorithm

After a review with inline comments is accepted or reconciled:

1. Query all PR review threads with cursor pagination.
2. Restrict candidates to comments whose review database ID matches the published review when available.
3. Parse only exact Leverframe markers from comment bodies.
4. Match each marker to the expected publication job and calculated fingerprint.
5. Require one and only one matching thread.
6. Persist the thread and comment node IDs transactionally.
7. Leave ambiguous or missing associations untracked and observable; do not infer by path and line.

Association is retryable without republishing the review during the active publication pass. The implementation polls a missing association three times with bounded backoff. If it remains missing or ambiguous, it logs the mismatch and does not infer by path or line. A durable association-repair queue remains future work and is not required while resolution is release-blocked and disabled.

## Resolution eligibility

A thread is eligible for automatic resolution only when all of these conditions hold:

- The current job is an incremental review that completed schema validation.
- The result contains an explicit `fixed` update for the fingerprint.
- The fingerprint exists in the exact prior review context supplied to the agent.
- The update evidence is non-empty after trimming and passes the configured body and redaction limits.
- A unique persisted or freshly reconciled Leverframe thread association exists.
- The associated thread is not already resolved.
- The GitHub query reports `viewerCanResolve: true`.
- The current GitHub PR head still equals the job's verified `headSha` immediately before resolution publication begins.
- The worker attempt remains current and has not been cancelled or superseded.
- The finding was published inline; summary-only findings are not eligible.

The following are never sufficient by themselves:

- The original thread is outdated.
- The original line was deleted.
- The file was renamed.
- The incremental diff touched the finding's file or line.
- The model omitted the prior finding from its output.
- A new review produced no new findings.

## Result validation changes

The JSON schema already requires evidence for each `finding_updates` entry. Add deterministic semantic validation after parsing:

- Reject duplicate update fingerprints in one result.
- Reject an update whose fingerprint was not present in the prior context supplied to the agent.
- Reject conflicting `fixed` and `still_present` updates for the same fingerprint.
- Reject blank evidence after trimming.
- Bound evidence by UTF-8 byte length before persistence and publication.
- Preserve omission as unknown rather than converting it to fixed.

Whether one invalid update should reject the whole review or only that update is a product choice. The first release should reject only the invalid update, record a validation limitation, and continue publishing otherwise valid new findings. A malformed top-level result should continue to fail the review as it does today.

## Publication order and failure semantics

Resolution is an external side effect and must not happen before the review result and local finding transitions are durable.

Recommended order:

```text
1. Verify the expected PR head and cancellation state.
2. Persist the validated review artifact.
3. Reconcile local finding states.
4. Publish or reconcile the new GitHub review.
5. Reconcile GitHub thread associations for newly published findings.
6. Create durable resolution intents for eligible fixed findings.
7. Recheck the PR head and cancellation state.
8. Post the idempotent evidence reply.
9. Resolve the thread with an idempotent GraphQL mutation.
10. Persist the resolved observation.
11. Complete the Check Run and status comment.
```

The evidence reply uses a unique hidden resolution marker. Before posting, the client searches the associated thread for that marker so a lost response cannot create duplicate replies.

The resolve mutation is naturally idempotent when preceded by an `isResolved` query. After an ambiguous mutation failure, query the thread again before retrying. Treat an already-resolved thread as success regardless of who resolved it, but record that Leverframe did not perform the resolution if GitHub exposes a different resolver.

### Should resolution failure fail the review job?

No. A successfully completed code review should not be rerun because a thread-management side effect temporarily failed. The job should reach `DONE`, while the durable thread row remains `RESOLUTION_PENDING` or `RESOLUTION_FAILED`. The Check Run summary and private UI should expose the degraded resolution count.

A small retry pass in the existing worker loop can process pending resolution intents without invoking the sandbox reviewer again. This avoids duplicate model cost and keeps GitHub failures separate from review correctness.

Permanent failures such as `viewerCanResolve: false`, a missing thread, or a GraphQL authorization error should remain observable and require operator action. Transient network, rate-limit, and 5xx failures should use bounded retries and later durable retry.

## Concurrency and cancellation

The feature must preserve the worker's current attempt fencing and active cancellation behavior.

- A newer head that arrives before the second head check cancels resolution for the old job.
- A cancellation after the final head check but during the GitHub mutation is an unavoidable narrow race. Resolving based on a head that was current immediately before mutation is acceptable; the next review remains responsible for detecting recurrence.
- A stale worker attempt must not create or update a resolution intent.
- A retry must not post a second evidence reply or resolve a different thread.
- Parallel workers are not currently supported, but database uniqueness and conditional updates should make the operation safe if worker concurrency is introduced later.

## Recurrence policy

The first release does not automatically unresolve threads. If a later review changes a locally `FIXED` finding to `STILL_PRESENT`, Leverframe should:

- Preserve the historical thread as resolved.
- Mark the local finding `STILL_PRESENT`.
- Report the recurrence in the Check Run and private UI.
- Avoid silently claiming a clean review.

This is intentionally conservative because the old thread may be outdated and a human may have interacted with it. A later design can add a distinct recurrence finding with current file and line information, which is preferable to unresolving stale context.

## Configuration

Do not make automatic resolution configurable in the first internal-only release. The feature should be guarded by an application-level environment flag during development and live validation:

```text
REVIEW_RESOLVE_FIXED_THREADS=false
```

After live validation, remove the temporary flag or default it to true for this single-operator MVP. A repository policy setting can be added when Leverframe supports multiple repositories with different operator requirements. Adding policy syntax now would expand the feature beyond the immediate need.

## Observability

At minimum, expose and log:

- Number of fixed finding updates received.
- Number eligible for thread resolution.
- Number of associations created, missing, or ambiguous.
- Number of threads already resolved.
- Number of evidence replies posted or reconciled.
- Number of successful, pending, and failed resolutions.
- The resolution job ID and verified head SHA for each resolved thread.
- Sanitized permanent failure reasons.

The review detail API exposes resolution data per finding so an operator can explain why a local `FIXED` finding still has an open GitHub thread.

## Security and privacy

- Only installation-scoped Octokit clients may query and mutate review threads.
- Never pass the installation token into the review result or resolution renderer.
- Parse exact hidden markers and verify the repository, PR, review, job, and fingerprint before mutation.
- Never accept a model-provided thread ID, comment ID, review ID, or marker.
- Resolve only threads associated with a review created by this Leverframe installation.
- Apply existing secret redaction and byte limits to stored and published evidence.
- Do not expose GraphQL errors containing tokens or sensitive headers through the public API.
- Keep resolution APIs outside the public review API in the first release; resolution is an internal consequence of a successful review, not an unauthenticated command surface.

## Implementation plan

### Phase 0: GitHub capability spike

- In the designated private live-test repository, confirm immediately before the test that the repository is private and PR `#1` is open.
- Publish one uniquely marked Leverframe test thread through the normal review mechanism or use an existing Leverframe-owned test thread.
- Query `reviewThreads` with the existing installation-scoped Octokit GraphQL client.
- Verify `viewerCanResolve` is true.
- Resolve the test thread with `resolveReviewThread`.
- Query it again and verify `isResolved` is true.
- Record the exact GraphQL shapes in a fixture and remove any temporary test content only when doing so is safe and explicitly within the test procedure.
- Do not use another repository or PR for live validation.

Result: failed. The existing installation token can query and associate its own thread but reports `viewerCanResolve: false`. Automatic resolution remains disabled.

### Phase 1: Deterministic identities and validation

- Extend `ReviewInlineComment` to carry a calculated fingerprint.
- Add a trusted inline marker renderer and parser.
- Add unit tests for marker round trips, malformed markers, body limits, and multiple findings at one location.
- Add semantic validation for duplicate, unknown, conflicting, and blank-evidence finding updates.
- Keep the review schema backward-compatible for artifacts that omit `finding_updates`.

Result: implemented and covered by unit tests. Every new inline finding has a deterministic marker and invalid resolution claims cannot reach publication code.

### Phase 2: Durable thread associations

- Add migration 4 for `github_finding_threads` and required indexes.
- Add a focused repository class for thread association and resolution state rather than expanding `JobDatabase` SQL directly.
- Implement paginated GraphQL thread discovery in `GitHubAppClient`.
- Reconcile markers after successful or recovered review publication.
- Add integration tests for migration idempotence, uniqueness, missing associations, ambiguous associations, and restart recovery.

Result: implemented prospectively. Each eligible newly published inline finding has one durable GitHub thread node ID, while missing or ambiguous associations are logged and never inferred from path or line.

### Phase 3: Resolution publication

- Create durable resolution intents from validated `fixed` updates.
- Implement thread-state refresh, `viewerCanResolve` enforcement, evidence reply reconciliation, and `resolveReviewThread`.
- Recheck the PR head and worker attempt before the first resolution side effect.
- Keep resolution failures separate from review job completion.
- Add bounded retry for pending intents without rerunning the sandbox.
- Update Check Run and status-comment summaries with resolution counts.

Result: implemented and covered by mocked response-loss and restart tests, but live resolution is blocked by GitHub authorization before the first mutation.

### Phase 4: Operator visibility and rollout

- Add resolution state to the private review detail API and shared contracts.
- Show fixed, still-present, resolution-pending, and resolution-failed states in the web detail view.
- Add Korean and English messages.
- Run unit, integration, executable E2E, and web E2E tests.
- Run the constrained private live test for a normal fix, a still-present finding, an already manually resolved thread, and an ambiguous API failure if it can be simulated without affecting other repositories.
- Keep the feature disabled until the authorization blocker is resolved, then monitor the first representative reviews after a successful repeated capability gate.

Result: implemented in the review detail API and web view. Rollout remains blocked by Phase 0.

## Test matrix

### Unit tests

- Marker rendering and parsing.
- Fingerprint association independent of line movement.
- Unknown and duplicate update rejection.
- Evidence rendering, redaction, and UTF-8 truncation.
- GraphQL response parsing with null nodes and pagination.
- Eligibility policy for fixed, still-present, omitted, summary-only, already-resolved, and non-resolvable threads.
- Retry classification for GraphQL transport, rate-limit, authorization, and semantic errors.

### Integration tests

- Migration from schema versions 1, 2, and 3 to version 4.
- Association persistence and uniqueness.
- Review publication response loss followed by review and thread reconciliation.
- Evidence reply response loss without duplicate reply.
- Resolve mutation response loss followed by an `isResolved` read.
- Process restart with pending resolution intents.
- Resolution failure does not rerun the reviewer or prevent a completed review artifact.
- Superseded and cancelled attempts cannot resolve threads.
- A changed PR head between review and resolution leaves the thread open.

### Live E2E tests

Use only `nbsp1221/skillpin-private-e2e-20260718` and existing PR `#1`, as required by repository instructions. Confirm privacy and open state immediately before every live test.

- Leverframe-authored inline thread can be discovered by marker.
- Existing App installation token reports `viewerCanResolve: true`.
- `resolveReviewThread` resolves the expected thread.
- A second resolution attempt is idempotent.
- A human-resolved thread is treated as success without another mutation.
- A `still_present` result leaves the thread unresolved.
- A newer push supersedes an in-flight resolution attempt.

## Rollback

- Disable `REVIEW_RESOLVE_FIXED_THREADS` to stop new resolution intents without stopping reviews.
- Pending intents remain durable but are not processed while disabled.
- The additive migration does not modify existing review artifacts or finding rows.
- Previously resolved GitHub threads are not automatically unresolved during rollback.
- Restore the previous application image if necessary; the older version should ignore the additive table after the normal SQLite backup procedure.

## Risks and mitigations

| Risk                                      | Impact                                                                    | Mitigation                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| False `fixed` judgment                    | An unresolved defect is hidden and a required-conversation gate may clear | Require explicit prior fingerprint and evidence, preserve omission as unknown, keep full review/check evidence, consider a later high-risk verifier |
| Wrong thread association                  | An unrelated conversation is resolved                                     | Trusted marker, review/job/fingerprint checks, unique association, never infer by path and line                                                     |
| New head races resolution                 | A judgment applies to stale code                                          | Existing cancellation plus a second head check immediately before side effects                                                                      |
| GraphQL permission mismatch               | Resolution fails in production                                            | Mandatory private capability spike using the actual installation token                                                                              |
| Ambiguous network result                  | Duplicate replies or repeated mutations                                   | Hidden resolution marker and read-after-failure reconciliation                                                                                      |
| GitHub eventual consistency               | Newly published thread is temporarily missing                             | Bounded immediate retry plus durable later reconciliation                                                                                           |
| Resolution outage reruns expensive review | Duplicate model cost and review noise                                     | Separate resolution intent state from review job completion                                                                                         |
| Historical comments lack markers          | Unsafe backfill                                                           | Enable prospective tracking only; leave historical threads manual                                                                                   |
| Evidence leaks sensitive content          | Secrets appear in GitHub or local API                                     | Trusted renderer, redaction, bounded evidence, no raw model logs                                                                                    |

## Go/no-go review

### Reasons to proceed

- The behavior is established in competing review products and directly removes manual review cleanup.
- GitHub provides first-class thread query and resolution APIs.
- The current App already has the expected Pull requests write permission.
- Leverframe already has incremental review context, stable finding fingerprints, explicit fixed/still-present updates, durable state, cancellation fencing, and publication reconciliation.
- The feature can be introduced additively without changing the public review API or granting the model GitHub access.

### Blocking release gates

- The private capability spike returned `viewerCanResolve: false` with the real installation token, so `resolveReviewThread` was not attempted through that token.
- Thread identity must be marker-based and durable before any automatic resolution is enabled.
- Invalid or unknown finding updates must be unable to trigger a mutation.
- Resolution failures must not cause sandbox reviews to rerun.
- Cancellation, supersession, response-loss, and restart tests must pass.
- Operator-visible failure state must exist before routine deployment.

### Final assessment

Do not enable automatic resolution with the current installation-token architecture. The one-agent semantic design, deterministic association, durable intent handling, UI visibility, and idempotent client behavior are implemented and testable, but the mandatory Phase 0 gate returned `viewerCanResolve: false` with the real App installation. Per the original stop condition, no additional scope or user authorization flow was added. Resume only after approving and designing a user-to-server authorization model, or after GitHub changes the installation-token capability and the same constrained live gate passes.
