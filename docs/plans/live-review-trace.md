# Live Review Trace

Status: Implemented and live-QA verified

Multica: PER-39

Branch: `codex/per-39-live-review-trace`

Base commit: `88d2cdb6f51c56f446eb838aea8f3409f13883ab`

Last reviewed: 2026-08-24

## Verification record

Repository verification passed on 2026-08-24 with `pnpm check`, covering formatting, lint, type checking, 149 tests, production builds, and the distribution smoke test. Both Compose services were rebuilt from the working branch and returned healthy; the deployed OpenAPI document exposed `getReviewExecution` and `streamReviewExecution`.

Live QA used only the existing open Pull Request `#1` in the confirmed private repository `nbsp1221/skillpin-private-e2e-20260718`. The `/retn0 review full` command created review job `63`; no new pull request was created. The browser showed the trace move from unavailable during checkout to a live Codex review, rendered two completed commands and expandable test output, reconnected without duplicating those commands, and automatically refreshed to the completed artifact after publication.

The completed trace contained 11 monotonic events, including matched command-start and command-completion events, separate process heartbeats, and a terminal turn event. An SSE request after sequence 5 replayed only sequences 6 through 11 and then emitted a completed snapshot before closing. The retained file was 5,988 bytes with mode `0600`, `trace_truncated` was false, and the API payload contained no reasoning event, final review JSON, recognized credential form, or host home path. A 390 by 844 viewport kept long commands within the card, and the rendered review detail had zero automated WCAG A/AA violations.

## Executive summary

Leverframe should let its operator see whether a long-running Codex review is making progress without exposing raw chain-of-thought or turning the product into a general terminal service. The first release should stream the stable JSON Lines output already produced by `codex exec --json`, normalize a small set of observable activities, persist a bounded and redacted execution trace beside the review job, and expose that trace through the existing private Reviewer API and review detail page.

The first release uses command-level live observability: a command appears as soon as Codex starts it, and its exit code and bounded aggregate output appear when Codex completes it. Bounded observable agent messages also appear after they are emitted. Byte-by-byte command output requires a move to Codex App Server and is intentionally deferred as a separate product and architecture decision.

This design is technically feasible in the current repository. It preserves the existing sandbox, final structured result, cancellation, supersession, publication, and automatic thread-resolution paths. It does not require a database migration or a feature flag.

## User intent

The request is motivated by a concrete operational problem: a review can run for 20–30 minutes while the web UI only says that it is reviewing, leaving the operator unable to distinguish healthy progress from a stuck process.

The intended outcome is:

- Open the review detail page and understand what the reviewer is doing now.
- See recent observable activity without refreshing the page.
- See enough command output to diagnose progress or failure.
- Retain the evidence-first and private-by-default philosophy of Leverframe.
- Avoid presenting hidden model reasoning as if it were inspectable or authoritative.
- Keep the implementation small enough to remain understandable and maintainable by a single operator.

## Product principles

### Observable facts, not simulated reasoning

The UI may display events that Codex explicitly emits, such as command starts, command completions, exit codes, bounded command output, file-change notices, tool calls, and agent messages. It must not invent a narrative about what the model is thinking, label silence as failure, or expose raw reasoning events.

### Diagnostics, not another source of truth

The review job row remains authoritative for lifecycle state, and the validated review artifact remains authoritative for findings and evidence. The execution trace is diagnostic data. A malformed or unknown trace event must never fail an otherwise valid review.

### Bounded by construction

Raw Codex JSONL, unbounded terminal output, dedicated source or diff payloads, credentials, and arbitrary host paths must not be available through the web API. Limits and redaction are applied before persistence, not only at render time. A bounded command-output excerpt can still contain repository text that the command itself printed, so the private deployment boundary remains mandatory.

### Private deployment boundary

The trace API is part of the existing private `/api/v1` surface. The public GitHub host continues to expose only the exact webhook endpoint. This feature does not add application-level authentication and therefore inherits the existing requirement that the operator UI and API stay behind a trusted private network.

### No feature flag

The behavior is always active after deployment. Old reviews that have no trace file return an explicit unavailable result. There is no compatibility fallback that attempts to reconstruct events from unrelated data.

## Current system

`SandboxReviewer` already invokes `codex exec --json` with a final output schema and `--output-last-message`. However, the generic `runProcess` helper buffers all stdout and stderr until the child exits. Only after exit does the reviewer write the complete stdout to `codex-events.jsonl`, and `ReviewWorker` deletes that file for every terminal outcome.

The web app is a separate container with no reviewer data volume or GitHub credentials. It receives review information through the Reviewer API. The private Caddy route already forwards `/api/*` to Reviewer, while the public host exposes only `/webhooks/github`.

The review detail page is server-rendered and already shows durable execution metadata, but it has no client-side execution feed. When a running review reaches a terminal state, the page also needs a refresh to load the completed artifact.

## External capability check

The official OpenAI documentation states that `codex exec --json` changes stdout into a JSONL stream containing events such as `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`. Item types include command executions, agent messages, reasoning, file changes, MCP calls, web searches, and plan updates. This is an appropriate stable source for command-level live observability. See [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

The official Codex App Server documentation exposes finer-grained notifications including `item/commandExecution/outputDelta`, as well as a wider thread and approval protocol. Some App Server methods and fields require explicit experimental API opt-in. Moving Leverframe to App Server would therefore be a transport and lifecycle redesign rather than a small enhancement to the current reviewer. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The first release should continue using `codex exec --json`. This provides live command start and event completion, but the product must not promise byte-by-byte command output before a command completes unless a local capability test proves that the installed CLI emits such deltas through this interface.

## Scope

### Included

- Stream `codex exec --json` stdout while the process is running.
- Preserve existing timeout and `AbortSignal` cancellation semantics.
- Frame newline-delimited JSON correctly across arbitrary chunk boundaries and flush a final partial line at process exit.
- Normalize supported Codex events into a versioned Leverframe execution event contract.
- Ignore unknown event types and record a bounded diagnostic counter rather than failing the review.
- Persist normalized events immediately in an append-only job trace.
- Give every event a monotonically increasing sequence number and attempt number.
- Record a throttled child-process heartbeat separately from the last Codex event so process liveness is not confused with productive activity.
- Expose an initial execution snapshot and a resumable Server-Sent Events stream through the private Reviewer API.
- Show current stage, elapsed time, last activity, current command, completed commands, exit codes, durations, bounded output, and terminal state on the review detail page.
- Refresh the server-rendered review detail automatically after the job reaches a terminal state so the final artifact becomes visible.
- Retain a completed bounded trace according to the review job's storage lifecycle.
- Cover success, failure, timeout, cancellation, supersession, process restart, malformed input, unknown events, output truncation, secret redaction, stream reconnection, and old reviews without trace data.

### Excluded

- Raw chain-of-thought or raw reasoning events.
- A claim that the UI exposes Codex's hidden internal conversation.
- Byte-by-byte terminal mirroring in the recommended first release.
- Interactive steering, approval responses, stdin input, or terminal emulation.
- Migration to Codex App Server, Codex SDK, Responses API, or WebSocket transport.
- A general log-search platform or event rows in SQLite.
- Public webhook-host access to trace endpoints.
- Reconstructing traces for historical jobs.
- A configurable feature flag, compatibility mode, or dual implementation.

## Product behavior

### Running review

The execution card appears for every review. For a new running review it shows the durable job stage, elapsed time from the current attempt, the latest child-process heartbeat, time since the last observable Codex event, and the latest active command if one exists.

New events appear without a page reload. Commands are ordered by sequence and show one of `running`, `completed`, or `failed`. Completed commands may expose a bounded output excerpt and exit code. Output is collapsed by default.

Silence is rendered factually as `Process heartbeat received …; no observable Codex event for …`; it is not labeled `stalled` or `failed`. A heartbeat proves only that the supervised child has not exited. Model inference can legitimately produce no command event for several minutes, and an alive process can still be unproductive, so the UI must not convert either signal into a health verdict.

### Terminal review

When the job becomes completed, failed, timed out, cancelled, or superseded, the stream sends a terminal snapshot and closes. The client refreshes the server-rendered route once to load the final review artifact and durable error fields.

The timeline remains available after completion if a trace exists. This makes the same UI useful for diagnosing slow and failed reviews, not just watching an active run.

### Old or unavailable trace

If no trace exists, the execution endpoint returns `available: false` with a stable reason such as `TRACE_NOT_CAPTURED`. The UI continues showing the existing durable execution metadata. Missing trace data is not treated as an API or review failure.

### Reconnect

Every trace event has a sequence number. The SSE event ID equals that sequence. The endpoint accepts the browser's `Last-Event-ID` and an explicit `after` query parameter for tests and non-browser clients. It replays only events with a greater sequence number and then follows new events.

The normalized trace is bounded by stopping additional persistence after the limit is reached. A reconnecting client receives every retained event after its last sequence and the snapshot explicitly reports that later diagnostic events were omitted.

## Information model

### Execution snapshot

The versioned contract is conceptually:

```json
{
  "review_id": 42,
  "available": true,
  "attempt": 1,
  "status": "running",
  "stage": "reviewing",
  "started_at": "2026-08-24T01:00:00.000Z",
  "process_heartbeat_at": "2026-08-24T01:03:20.000Z",
  "last_activity_at": "2026-08-24T01:03:12.000Z",
  "last_sequence": 17,
  "trace_truncated": false,
  "current_command": {
    "item_id": "item_7",
    "command": "pnpm test --filter reviewer",
    "started_at": "2026-08-24T01:03:12.000Z"
  },
  "events": []
}
```

`status` is derived from the durable review job. `stage` is the normalized current database state. `last_activity_at`, `last_sequence`, current command, and events are derived from the normalized trace.

### Normalized events

The first schema version supports:

| Event               | Required data                                        | Purpose                                                                                     |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `attempt_started`   | attempt                                              | Separate restarts and retries without overwriting history.                                  |
| `process_heartbeat` | attempt                                              | Prove only that the supervised Codex child has not exited; hidden from the visual timeline. |
| `thread_started`    | redacted thread identifier or no identifier          | Confirm that Codex accepted the run.                                                        |
| `turn_started`      | none                                                 | Mark model execution start.                                                                 |
| `command_started`   | item ID, bounded command                             | Show current observable work immediately.                                                   |
| `command_completed` | item ID, status, exit code, duration, bounded output | Show command result and evidence.                                                           |
| `agent_message`     | bounded text                                         | Show observable progress messages, subject to the pending product decision below.           |
| `file_change`       | bounded paths and status                             | Show that Codex changed files in the sandbox without exposing the diff.                     |
| `tool_activity`     | bounded tool name and status                         | Represent MCP or web activity without raw payloads.                                         |
| `turn_completed`    | bounded usage fields when present                    | Mark successful Codex turn completion.                                                      |
| `turn_failed`       | bounded redacted error                               | Mark Codex turn failure.                                                                    |
| `trace_notice`      | code and bounded detail                              | Represent malformed lines, unknown event counts, and truncation without exposing raw input. |

Every stored event contains `schema_version`, `sequence`, `attempt`, `observed_at`, and `type`. Raw Codex event objects are not part of the API or storage contract.

Even if observable agent messages are enabled, the final schema-conforming review response is suppressed from the trace because the validated artifact already renders that information. This prevents a duplicate raw JSON review result from appearing in the execution timeline.

### Terminal state ownership

The database owns job state. The trace store does not independently decide that a review succeeded, failed, timed out, was cancelled, or was superseded. Snapshot assembly merges the current database job with the trace so the UI cannot show a diagnostic file as more authoritative than durable lifecycle state.

## Storage design

Add an `ExecutionTraceStore` initialized once from `jobsDirectory` and inject the same abstraction into `SandboxReviewer`, `ReviewWorker`, and the API route registration.

The file path is `<jobsDirectory>/<jobId>/execution-trace.jsonl`. It is created with directory mode `0700` and file mode `0600`. A new attempt appends `attempt_started`; it does not rewrite a prior attempt. Sequence allocation continues from the last valid stored event.

The trace store owns:

- UTF-8-safe truncation.
- ANSI escape and disallowed control-character removal.
- Credential redaction using a shared operational-text sanitizer derived from the existing failure redactor.
- Host-path normalization where a known private data root appears.
- JSONL append and read validation.
- File and event limits.
- Snapshot reduction, including current command and latest activity.

While the Codex child exists, `SandboxReviewer` records a heartbeat at most once every 15 seconds. Heartbeats update `process_heartbeat_at` but never update `last_activity_at` and are not rendered as timeline rows. The timer is stopped in a `finally` path for success, failure, timeout, and cancellation.

Recommended fixed limits for the first release are:

- Command: 2 KiB after redaction.
- Agent message: 4 KiB after redaction.
- Output excerpt: final 16 KiB per completed command after redaction.
- Normalized events: 512 per review job, including heartbeats.
- Trace file: 4 MiB per review job.

These are code constants, not environment variables. When a limit is reached, the store records one `trace_notice` when space permits, sets `trace_truncated`, and discards additional diagnostic payload while the review continues normally.

The output excerpt uses the tail because compiler and test failures usually place their actionable summary at the end. The event records whether earlier bytes were omitted.

No SQLite migration is proposed. Trace events are high-frequency diagnostic data, do not participate in relational queries, and already have a natural per-job filesystem owner. The existing job and artifact database records remain unchanged.

## Process execution design

Keep `runProcess` for commands that need only a buffered result. Add a generic streaming variant in `system/process.ts` rather than putting Execa stream handling inside `SandboxReviewer`.

The streaming helper must:

- Use the same timeout and cancellation behavior as `runProcess`.
- Invoke callbacks for stdout and stderr chunks without awaiting arbitrary application work inside the stream backpressure path.
- Maintain bounded stderr and optional stdout tails for thrown process errors.
- Propagate spawn, timeout, cancellation, and non-zero exit errors using the same observable semantics as the current helper.
- Never log the command input, because installation credentials are passed to checkout commands over stdin elsewhere in the reviewer.

`SandboxReviewer` uses a line framer over stdout chunks. Each complete line is offered to the Codex event normalizer and immediately appended when supported. The final structured review continues to be read from the existing sandbox output file written by `--output-last-message`; the execution trace is not used to construct the review result.

If parsing a line fails, the recorder increments a malformed count and emits at most one bounded notice per attempt. If an event type or item type is unknown, it increments an unknown count. Neither condition changes process exit handling.

## API design

Add the following private endpoints:

```text
GET /api/v1/reviews/{reviewId}/execution
GET /api/v1/reviews/{reviewId}/execution/events?after={sequence}
```

The first endpoint returns the current snapshot plus all retained normalized events. It is described in OpenAPI using contracts from `@repo/contracts`.

The second endpoint returns `text/event-stream`. It validates the review ID before opening the stream, replays retained events after the requested sequence, follows appended events, emits a lightweight snapshot when the durable stage changes, sends a comment heartbeat at a conservative interval for proxy health, and closes after a terminal snapshot.

SSE is selected instead of WebSocket because the browser only consumes server-to-client data, native reconnection carries `Last-Event-ID`, and the current private Caddy route can proxy a standard HTTP response. The server may poll the bounded trace file and database internally at a one-second cadence; this avoids an in-memory event bus and remains appropriate for the single-operator MVP.

API responses must set `Cache-Control: no-store`. The SSE response also sets `Content-Type: text/event-stream`, `Connection: keep-alive` where supported, and disables proxy buffering when applicable.

The existing review detail response remains unchanged. Keeping live trace behind its own endpoint avoids making every list/detail request read and parse a diagnostic file.

## Web design

Add a client component under the existing server-rendered review detail page. The server page passes only the review ID and initial durable status. The client fetches the execution snapshot, then opens an `EventSource` from the latest sequence.

The card shows:

- Durable stage and status.
- Attempt number.
- Locally ticking elapsed time.
- Relative time since last observable activity.
- Current command with an active indicator.
- Chronological command and observable activity entries.
- Exit code and duration for completed commands.
- Collapsed bounded output with a visible truncation label.
- Connection state as a secondary indicator, separate from review state.

If the SSE connection is interrupted, the card shows `Reconnecting` but does not mark the review as failed. `EventSource` reconnects using the last event ID. Duplicate sequence numbers are ignored client-side.

When a terminal snapshot arrives, the component closes its stream and calls `router.refresh()` once. The refresh loads the completed artifact while the retained trace remains mounted in the client component.

English and Korean copy, keyboard navigation, screen-reader status announcements, reduced-motion behavior, narrow layouts, long unbroken commands, and empty output are included in the UI acceptance criteria.

## Security and privacy

The sandbox installation token used for Git fetch is passed over stdin and is not part of the Codex command. Nevertheless, repository commands and tests can print arbitrary values, so private-network placement alone is insufficient.

The implementation applies the following controls before data reaches disk:

- Redact authorization, cookie, and set-cookie header values.
- Redact PEM private keys, JWTs, known GitHub token forms, and values from secret-like process environment variables.
- Remove ANSI escapes and non-printing control characters except newline and tab.
- Replace the configured private data root and recognized host home paths with stable placeholders.
- Truncate each field and the total trace.
- Never persist raw events alongside the normalized trace in production.
- Never add raw reasoning events, raw tool payloads, full diffs, or full file contents as dedicated trace fields. Bounded command output remains opaque operational text and can contain repository content emitted by the command.

Redaction is defense in depth, not a proof that arbitrary command output contains no sensitive business data. This is why the endpoint remains private and output is bounded.

## Failure and recovery semantics

| Situation               | Review behavior                                     | Trace behavior                                                                                 |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Malformed JSONL line    | Continue review.                                    | Record a bounded notice and count.                                                             |
| Unknown Codex event     | Continue review.                                    | Ignore payload and count.                                                                      |
| Trace append failure    | Continue review and log a sanitized server warning. | The snapshot may be unavailable or stop advancing; it must not claim that tracing is complete. |
| SSE client disconnect   | Continue review.                                    | Reconnect from last sequence.                                                                  |
| Reviewer restart        | Active job is requeued by existing logic.           | New attempt appends to the same monotonic trace.                                               |
| Timeout                 | Existing timeout result remains authoritative.      | Terminal snapshot reflects failed/timed-out state.                                             |
| Cancellation            | Existing cancellation remains authoritative.        | Terminal snapshot reflects cancelled state.                                                    |
| Supersession            | Existing supersession remains authoritative.        | Terminal snapshot reflects superseded state.                                                   |
| Trace limit reached     | Continue review.                                    | Set truncation metadata and discard later diagnostic payload.                                  |
| Old review without file | No effect.                                          | Return `TRACE_NOT_CAPTURED`.                                                                   |

The old raw `codex-events.jsonl` persistence and its terminal cleanup are removed. Only the normalized bounded trace is persisted, and it is not deleted at terminal transition.

## Testing plan

### Unit tests

- JSONL framing across split chunks, multiple lines per chunk, CRLF, empty lines, and final partial line.
- Supported command, message, file-change, tool, turn, and error normalization.
- Unknown and malformed event tolerance.
- Sequence continuation across attempts.
- Snapshot reduction, heartbeat/activity separation, and current-command matching by item ID.
- UTF-8-safe head/tail truncation.
- ANSI/control removal and credential/path redaction.
- Event-count and file-size limits.

### Process integration tests

- stdout callbacks occur before child process exit.
- delayed output is observable while the child is still running.
- stderr tail is bounded on failure.
- timeout and external cancellation terminate the child promptly.
- the heartbeat stops after every process exit path.
- callback or recorder failure does not leak an unhandled stream error.

### Reviewer integration tests

- A mocked Codex JSONL stream creates normalized events before the final result is read.
- The final review still comes only from `--output-last-message` and schema validation.
- Installation tokens and raw JSONL are absent from the trace.
- Success, non-zero exit, timeout, cancellation, and restart produce the expected trace and durable job state.

### API tests

- Snapshot validation for running, terminal, missing, and historical jobs.
- `404` and `422` behavior matches existing review endpoints.
- SSE replay starts after the supplied sequence.
- Reconnect does not duplicate events.
- Stage changes and terminal closure are emitted.
- Cache, content type, heartbeat, and private API documentation remain correct.
- OpenAPI and generated LLM documentation do not contain local paths or secrets.

### Web tests

- Running, reconnecting, terminal, unavailable, and truncated fixture states.
- Current command and elapsed time update.
- Process heartbeat and last Codex activity are displayed as separate facts.
- Completed output is collapsed and keyboard accessible.
- Duplicate events are ignored.
- Terminal state triggers one route refresh.
- Korean and English messages render without missing keys.
- Mobile and desktop layouts remain usable.

### Repository and live QA

- Run focused package tests during implementation.
- Run the complete `pnpm check` before push.
- Rebuild the local Compose services and verify Reviewer and Web health.
- Confirm immediately before every live mutation that `nbsp1221/skillpin-private-e2e-20260718` is private and PR `#1` is open.
- Trigger one real review on that PR, open its Leverframe detail page while it runs, verify live command events and reconnection, and verify that the final artifact appears without a manual reload.
- Confirm that no other repository or PR receives a test event.

## Implementation plan

### Phase 1: contracts and trace domain

1. Add execution snapshot and normalized event schemas to `@repo/contracts`.
2. Implement `ExecutionTraceStore`, sanitization, bounds, append, read, and snapshot reduction.
3. Add unit tests before connecting the store to process execution.

### Phase 2: streaming execution

1. Add the generic streaming process helper while preserving `runProcess` for existing callers.
2. Add the Codex JSONL framer and normalizer.
3. Change only the Codex invocation in `SandboxReviewer` to use the streaming path.
4. Keep final result loading and validation unchanged.
5. Replace terminal deletion of raw Codex events with retention of only the normalized trace.

### Phase 3: API and transport

1. Construct one trace store in the CLI composition root and inject it explicitly.
2. Add the snapshot endpoint with OpenAPI contracts.
3. Add the resumable SSE endpoint and terminal closure.
4. Add integration and documentation-boundary tests.

### Phase 4: web UI

1. Add a focused client-side `ReviewExecutionTrace` component.
2. Add translations and fixture states.
3. Add reconnection, de-duplication, elapsed-time, terminal refresh, and accessible output disclosure.
4. Add browser tests.

### Phase 5: verification and delivery

1. Run focused tests, then the complete repository check.
2. Rebuild Compose and run local API/UI smoke tests.
3. Run the permitted Skillpin live QA and record evidence in PER-39.
4. Review the final diff for responsibility boundaries, duplication, dead flags, and accidental raw-output exposure.
5. Use the `commit` skill for logical commits and push while no PR exists.
6. Report test and live-QA results. Do not create a PR until the user explicitly approves it.

## Expected change surface

The exact filenames may change during implementation, but the expected ownership is:

- `packages/contracts`: public execution trace schemas and types.
- `apps/reviewer/src/system`: generic streaming subprocess boundary.
- `apps/reviewer/src/sandbox`: Codex event framing and normalization.
- `apps/reviewer/src/storage` or a dedicated execution module: bounded trace persistence and snapshot reduction.
- `apps/reviewer/src/app`: snapshot and SSE endpoints plus composition-root injection.
- `apps/reviewer/src/jobs/worker.ts`: lifecycle integration and removal of raw-event deletion.
- `apps/web/src/features/reviews`: client execution card and stream state reducer.
- `apps/web/messages`: Korean and English copy.
- Reviewer and web tests corresponding to each boundary.
- `AGENTS.md`: durable change-workflow rules requested by the operator.

No change is expected in GitHub App permissions, webhook subscriptions, review output schema, review prompt, publication logic, finding reconciliation, or automatic thread resolution.

## Design review

### Why this structure is reasonable

- The process helper owns process semantics rather than Codex event meaning.
- The normalizer owns external event compatibility rather than file I/O or UI concerns.
- The trace store owns bounds, sanitization, persistence, and reduction in one place, avoiding repeated security logic across the API and web.
- The database remains authoritative for lifecycle state and is not burdened with high-frequency diagnostic rows.
- The API remains the only cross-container data boundary.
- SSE matches the one-way, single-operator use case without introducing WebSocket state or an event broker.
- The final review artifact path stays independent, so trace failures cannot corrupt review correctness.

### Main risks and mitigations

| Risk                                    | Mitigation                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Codex adds or changes event types.      | Parse a small supported subset, ignore unknown types, and test malformed input.           |
| Command output leaks sensitive data.    | Redact and truncate before persistence; private API only; collapsed UI.                   |
| A large stream consumes memory or disk. | Incremental parsing, bounded tails, fixed event and file caps.                            |
| File polling adds load.                 | One-second cadence, bounded files, and single-operator scope.                             |
| UI implies model health from silence.   | Separate process heartbeat from last Codex activity and avoid a stalled verdict.          |
| Restart mixes attempts.                 | Include attempt on every event and append an explicit attempt boundary.                   |
| Trace implementation breaks reviews.    | Treat normalization and persistence as best effort; keep final artifact path independent. |
| API route learns filesystem details.    | Inject a trace-store abstraction from the composition root.                               |

### Go/no-go assessment

The design is a technical go for command-level live observability. It uses a documented stable CLI stream, aligns with the current container and private API architecture, does not require new GitHub or OpenAI permissions, and has bounded operational risk.

The product decisions below are approved. The design is ready for implementation after the remaining explicit implementation approval gate.

## Approved product decisions

The operator approved the recommended `1A + 2A + 3A` combination on 2026-08-24.

### Decision 1: command-level live granularity

Use `codex exec --json`. Commands appear when started; their bounded output and exit code appear when completed. A child-process heartbeat remains visible during a long command. Byte-by-byte stdout and App Server migration are deferred.

### Decision 2: bounded observable agent messages

Show bounded `agent_message` events because they are explicit model output and can explain progress between commands. Suppress the final schema-conforming review response and discard every reasoning event.

### Decision 3: retain completed traces

Retain the bounded normalized trace for the same lifetime as the review job. This enables diagnosis after a 20–30 minute run finishes or fails. The hard maximum remains 4 MiB per job; a global job-retention policy is outside this feature.

## Approval gate

Implementation was approved on 2026-08-24 and is proceeding through the phases above. Creating a pull request remains a separate human approval gate.
