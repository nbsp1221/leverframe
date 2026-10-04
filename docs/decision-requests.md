# Decision requests

The decision workspace separates human responses, delivery to an agent, and the agent's report of applying a decision. A research request remains unresolved until the findings return and the user makes a decision. An agent application report is not independent verification that implementation is correct.

## Boundaries

`packages/contracts/src/decisions.ts` defines the HTTP contract. The web feature uses that API without importing storage, agent clients, or preview scenarios. `DecisionService` owns revisions, response idempotency, delivery states, and outcome correlation. `DecisionRepository` and `AgentGateway` are its ports; SQLite implements storage. The existing HTTP server accepts an optional decision service at composition time. Without it the decision endpoints return 503, and no fixture data or agent connection is installed in production.

The scripted agent lives under `apps/reviewer/tests/fixtures/`. It accepts deliveries and produces separate investigation, clarification, and application events. Preview choices represent illustrative scenarios, not real project approvals. Free text is returned for clarification, not interpreted by a model. No real project execution or external publication occurs.

## Request workspace

The workspace separates requests to answer, responses being followed up, deferred requests, and past requests. Delivery problems remain in follow-up rather than asking the user to answer again. Retry is explicit; the preview does not claim automatic recovery. Scope and important conditions remain visible before responding, while background evidence and history are expandable. Returning requests show the last response and the agent's subsequent update; an older update is not presented as the result of a newer response.

`POST /api/v1/decisions/{id}/snooze` takes `expectedRevision` and `deferred`. Deferring stores a one-hour return time on the server without changing the unanswered state or dispatching work. Waking clears the return time. Expired deferrals reappear in the answer view when refreshed. The same revision checks prevent another tab from deferring a request that has already changed. This is visibility scheduling, not execution authorization or a notification delivery service. Filters and selection use URL parameters; unsent drafts remain local to the browser tab.

## Run the development preview

From a task worktree, install the frozen dependencies and run the existing test backend:

```sh
pnpm install --frozen-lockfile
LEVERFRAME_PREVIEW_ROOT=/absolute/path/to/local-preview-data pnpm --filter @repo/reviewer exec tsx tests/e2e/web-fixture.ts
```

In a second terminal:

```sh
REVIEWER_INTERNAL_URL=http://127.0.0.1:16722 pnpm --filter @repo/web exec next dev --hostname 127.0.0.1 --port 16721
```

Open `/ko/decisions` or `/en/decisions`. The backend listens on loopback. `LEVERFRAME_PREVIEW_ROOT` retains answers in an isolated SQLite database between restarts; omit it for a temporary test run. An existing seed is not overwritten. Stop the preview before removing its local data directory to reset all scenarios. Do not use a production data directory. `LEVERFRAME_PREVIEW_PORT` can override the backend port.

## Connect a Codex Desktop test conversation

The development backend can opt into the existing local Codex Desktop daemon. Set `LEVERFRAME_CODEX_CONFIG` to a private JSON file when starting the test backend. Keep both connection files outside Git with mode `0600`. The server configuration contains `socketPath`, a random `token` of at least 32 characters, and `threads`, an explicit map from allowed thread IDs to their working directories. It never starts another daemon, resumes an unloaded thread, or changes Codex configuration. This adapter depends on the installed daemon's local Unix WebSocket and experimental direct-input fields; it is not a portable guarantee for every Codex release.

The bundled `.agents/skills/leverframe-ask/SKILL.md` describes only the script workflow. Its Python 3 script requires no package install or build. Pass a separate agent connection file containing `url` (the loopback backend), `uiUrl` (the request workspace URL), and the same `token` using `--config` or `LEVERFRAME_AGENT_CONFIG`. Explicitly provide this skill's path to a test conversation outside the repository; repository-local discovery does not install the skill globally. Do not paste the token into a prompt. Run `ask.py --help` for the question JSON format. The script derives the thread ID from `CODEX_THREAD_ID`, sends the file with a stable question key, and prints the saved request ID and URL. Plain HTTP is restricted to loopback, redirects and environment proxies are disabled, and credentials are not printed.

`POST /api/v1/decisions` requires the registration bearer token. It accepts question content, `threadId`, and `key`; the server assigns lifecycle state, event history, and the originating turn from the allowed live conversation. A duplicate key and canonical payload return the existing request across restarts. Changed content under the same key returns 409. The registration token does not represent a human answer. Existing UI answer endpoints still assume the private trusted-network boundary; this is not a multi-user authorization system. OpenAPI, `/docs` and `/llms.txt` describe the same registration contract.

New questions must explicitly record the agent's recommendation: exactly one option has `recommended: true` and `recommendation` contains its reason. If the available evidence cannot support a recommendation, all flags are false, `recommendation` is empty, and `recommendationUnavailableReason` explains the missing basis. The script gives actionable validation feedback before sending; the API also validates direct callers. Older stored requests remain readable, but an old payload that silently omitted the recommendation no longer passes registration validation. Do not fabricate a recommendation when repairing an old request.

The workspace marks the recommended option with an AI recommendation badge without selecting it for the user. It retains the badge beside the last response when that option was chosen. Recommendation reasoning is available under background and evidence; it is not a separate paragraph below the choices. Recommendation updates in existing requests advance the revision and leave an audit event so stale drafts require review.

After the user answers through the workspace, the worker sends the exact question, constraints, selected option, and free text into a new turn in the original conversation. The first integration ends at `delivered`; it does not turn the model's prose into a verified application event. Scripted fixture outcomes apply only to the known fixture thread IDs, never live threads.

## Delivery guarantees and limits

Before delivery the adapter reads the conversation and checks its identity, original turn, loaded state, and ability to receive direct input. Busy/offline targets remain visible as delivery failures for explicit retry; a later unrelated turn makes the request superseded. The adapter reserves a durable delivery identity before `turn/start`. On retry it first looks for the exact response message in the original conversation. A matching receipt confirms delivery; a reservation without a receipt stays uncertain and is not automatically resent, including after restart. Failure to find a message is not proof that sending again is safe. The receipt confirms input acceptance, not successful work.

The single development worker serializes local dispatch. SQLite rejects stale user writes and competing delivery reservations, but this does not arbitrate human writes in Codex Desktop. There is still a race between the final read and `turn/start`; run the first integration in a dedicated test conversation without concurrent human input. Exclusive control, unloaded-thread recovery, daemon restarts, arbitrary background process cancellation, and agent outcome reporting remain outside this increment. The blocking flag and skill instructions are cooperative behavior, not an enforced runtime pause. No exactly-once execution or production readiness is claimed.

## Verification

```sh
pnpm --filter @repo/reviewer exec vitest run tests/integration/decisions.test.ts tests/integration/decision-codex.test.ts
```

The tests cover persistence across store restart, stale answers, duplicate requests, offline delivery, superseded tasks, investigation versus approval, delayed outcome rejection, and the HTTP boundary. Browser checks exercise the same endpoints and application service, not client-side mock responses.
