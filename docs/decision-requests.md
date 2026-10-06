# Decision requests

The request inbox separates a human response, its delivery to the original agent conversation, and a report that the decision was applied. Research is not implementation approval. Receiving a response is not evidence of successful implementation.

## Architecture

`DecisionService` owns revisions, response idempotency and state transitions. `SessionDecisionGateway` builds the scoped response, checks the original session’s availability and reconciles delivery receipts. These application modules depend on ports, not ACP, Codex RPC, sockets, subprocesses or SQLite implementations.

`agent-connections/ports.ts` defines a session observer and prepared message channel. A connection ID namespaces session IDs, which are opaque strings rather than globally unique Codex UUIDs. The observer reports readiness, checkpoint and received messages. `AcpSessionChannel` implements the channel with the pinned ACP TypeScript SDK, using stdio or the SDK's experimental WebSocket transport. Adding an agent requires a channel and an observer that can establish the necessary evidence; merely accepting ACP prompts is insufficient for safe retry.

`createDecisionRuntime` is the normal application composition root. It constructs connections, storage and the persistent delivery worker without importing fixtures. `leverframe serve` enables it when `LEVERFRAME_DECISION_CONFIG` points to a configuration file. Without that setting, inbox endpoints return 503. The existing review/development execution engines are not migrated by this feature.

The connector Codex app-server profile uses pinned `codex-acp` and the bundled Node-based `desktop-bridge`. The older static profile also supports `codex-desktop-bridge.sh` with operator-provided `websocat`. The wrapper attaches to an existing Codex app-server; it never starts a replacement daemon. The adapter sends through ACP only. A separate read-only Codex observer uses `thread/read` and `thread/loaded/list` to check identity, turn state and receipts, because ACP v1 does not provide those guarantees. There is no native sender fallback. The profile depends on the installed Codex app-server's experimental direct-input fields and Unix WebSocket compatibility.

The runtime is Codex's `app-server`, available through the Codex CLI; a Desktop GUI is not a dependency. [Codex documents starting app-server and attaching the CLI terminal interface](https://learn.chatgpt.com/docs/app-server#connect-the-cli-terminal-ui). This connector requires a Unix WebSocket endpoint and discovers exactly one socket under `/tmp/codex-daemon-<uid>`. Advanced operators can supply `--socket /absolute/socket` to `connector.js connect`; the generated installer uses discovery. The connector does not install, start, authenticate or supervise app-server. Starting an arbitrary standalone CLI process does not establish this shared endpoint.

Compatibility evidence is limited to Codex CLI 0.159.2 with an existing app-server, pinned `codex-acp` 2.1.1 and ACP SDK 1.5.0. An isolated, GUI-free app-server passed startup and read-only RPC checks; a fresh CLI-only machine's installation, authentication and full question/answer workflow have not been verified. Cross-machine tests moved the core and connector to separate hosts while keeping the Codex runtime on the original host through an SSH socket tunnel. They do not prove a fresh remote Codex installation. The static configuration kind `codex-desktop` and bridge filenames are retained for compatibility; those names do not require a Desktop GUI.

## Connect a computer

Open **Settings → Connected computers** (`/ko/settings/connections` or `/en/settings/connections`) and select **Connect computer**. Run the generated command on the Linux computer with a compatible Codex app-server already running. It installs the connector under `~/.local/share/leverframe-connector` and the question skill under `~/.agents/skills/leverframe-ask`, then starts a background process. Node.js 24+, Python 3 and curl are required. No sudo, global package install, system service or shell-profile edit is performed. The process survives terminal closure but is not registered for OS boot; after a reboot run `node ~/.local/share/leverframe-connector/bin/connector.js start`.

The single-use enrollment code expires after ten minutes. The computer receives its own revocable credential; only its hash is stored on the core. The connector keeps private local credentials and exposes the skill endpoint on loopback only. It makes outbound authenticated HTTP requests to the core, so the computer does not need an inbound network port. Use HTTPS or an explicitly trusted private network. Public plaintext URLs, embedded URL credentials and redirects are rejected. The web/core is still an operator-owned private deployment, not a multi-user authentication service.

Enrollment covers conversations in that connected Codex app-server, without project selection or per-session registration. The skill obtains the session ID from its execution environment, the connector reads the actual session and working directory, and the core persists the binding on the first question. Project labels are display context, not routing authority. A standalone CLI conversation outside the connected app-server is not automatically reachable. Other providers and ambiguous socket discovery are not supported by this first profile. Local users able to read the connector credentials belong to the trusted device boundary.

The screen separates computer connectivity, app-server reachability, skill installation, question arrival and verified answer delivery. **Try it** provides a message to send in a fresh Codex conversation and a link to answer in the inbox. Installing the skill does not guarantee that every existing turn discovers it immediately or that the model asks every necessary question. Opening a new conversation is the supported activation path. A delivered answer is not evidence of implementation.

Disconnecting revokes future requests and claims but retains saved questions, answers and routing history. An already in-flight agent operation cannot be undone. To reconnect a revoked installation, generate a new command; the connector verifies the old credential was revoked before replacing its own identity. Existing unrelated skill installations are never overwritten. `stop`, `status`, and `uninstall` are available through the installed `connector.js`; stop before uninstalling. Uninstall removes the owned skill and identity, not the saved core inbox or other user files.

## Core configuration and distribution

Keep the dedicated inbox database and registration token outside Git, restricted to the service user. The normal `LEVERFRAME_DECISION_CONFIG` can now start with no static connections:

```json
{
  "version": 1,
  "databasePath": "/private/leverframe/inbox.sqlite",
  "tokenFile": "/private/leverframe/registration-token",
  "legacyConnectionId": "desktop-local",
  "connections": []
}
```

The legacy registration token still requires at least 32 characters. It is not distributed to enrolled computers. `pnpm --filter @repo/reviewer build` creates the downloadable installer and self-contained JavaScript bundle under `dist/connector`. The bundle contains the pinned `codex-acp`, ACP SDK and Node-based app-server bridge; it needs no external websocat installation. Source-mode servers set `LEVERFRAME_CONNECTOR_ARTIFACTS` to that absolute directory. Built servers use the adjacent `connector` directory. The web proxy forwards scoped connector credentials and binary downloads without exposing configuration files.

The core persists enrollment, automatic session bindings and an outbound command mailbox in the inbox database. The mailbox transports session-port operations; agent framing, loading and prompts still use the existing ACP implementation on the connector. Adapter preparation finishes before the business delivery reservation is taken. Claimed commands are never automatically reissued after a lost reply, and the connector retries receipt publication without repeating execution. Prepared adapters expire and close owned subprocesses. If a persisted session is no longer loaded, the connector can load that exact session through ACP without prompting or executing a turn, then observe it again. The normal identity and readiness checks still gate answer delivery; active loaded sessions are not replaced. A send rechecks command authorization and current session readiness; no arbitrary shell execution is exposed by the core mailbox.

Static `connections` remain available for controlled legacy migration and advanced operator profiles. They still use an explicit session allowlist, absolute observer paths and stdio or authenticated WebSocket ACP transports. New computer connections do not require those entries. Provider-specific adapters remain behind the session ports; the question/answer business service does not depend on device transport.

## Agent skill and API

The bundled `.agents/skills/leverframe-ask/SKILL.md` uses a Python 3 script without external dependencies. After connector installation the normal command is `python3 <skill>/scripts/ask.py --key <stable-question-key> --file <question.json>`. The script discovers its adjacent private connection file, with the user-wide installation as a fallback for the repository-local skill. No per-conversation configuration argument is needed.

The script reads `LEVERFRAME_SESSION_ID`, falling back to `CODEX_THREAD_ID`. It submits the source to the local connector, which verifies it and adds the enrolled connection identity. Question content cannot override that identity. The connector credential authorizes only its own polling, result publication and question submission. The original `--config` / `LEVERFRAME_AGENT_CONFIG` direct API path remains compatible for existing integrations. The script disables redirects and environment proxies, restricts plain HTTP to loopback and never prints credentials.

`POST /api/v1/decisions` requires the registration bearer. It accepts question content, a source and `key`; the server derives the originating checkpoint from the allowed actual conversation. A duplicate key and payload return the existing request across restarts. Changed content under the same key returns 409. New identities include the connection namespace. Legacy creation identities and hashes are preserved. OpenAPI, `/docs` and `/llms.txt` describe the same contract.

Every new question includes exactly one recommended option with a reason, or explicitly states why the evidence cannot support a recommendation. The UI marks that option without choosing it for the user. Question scope remains visible; supporting evidence and event history can be expanded. Unsent drafts stay in the browser tab. Deferring a question schedules its visibility, not permission to execute.

For a blocking question the skill tells the agent to stop dependent work and finish the turn normally. A response returns as a new message in the original conversation. For nonblocking questions the agent may continue only independently authorized work. Later conversation turns do not invalidate a saved question. The response is delivered to the same conversation when it becomes idle, and the agent interprets it under the user’s stated scope. Leverframe does not infer whether a topic change makes a question irrelevant. The user can explicitly discard an unanswered request; its history remains, no answer is sent, and the agent’s work is not cancelled. Discard and answer both require the current request revision, so a stale tab cannot discard a concurrently saved answer.

## Delivery and recovery

Saving an answer and creating its delivery outbox row are one SQLite transaction. The worker processes persisted rows after restart. The worker permits up to four concurrent sessions, keeps each session’s unresolved head in order, and backs off failed attempts from two seconds up to one minute. Other sessions do not wait for one offline target unless all concurrency slots are occupied. Session locks serialize different deliveries to the same connection/session. A stable delivery ID and payload hash are reserved before sending. Competing workers can observe the same delivery, but only one can reserve its first send.

The gateway checks the actual conversation before loading the adapter and immediately before sending. Busy or disconnected targets remain in follow-up with specific explanations and are checked automatically. A cancelled or unavailable session remains pending instead of being automatically resumed. A later completed turn alone is not evidence that a question was cancelled. Old stored superseded states are retained for history; pending questions are not automatically discarded when a turn changes. Missing ACP load support is reported as unsupported; no replacement conversation is created. Additional tool permission requests received through ACP are denied, not automatically approved; this integration is not a general approval forwarding UI.

After sending, the observer must find the exact response in the original conversation to confirm delivery. A successful ACP prompt alone is insufficient. If the network response is lost, a later receipt check can recover without resending. A reservation without a receipt remains unconfirmed, including after restart and manual retry. Failure to find a message is not proof that resending is safe. An ambiguous delivery holds its session lock until its receipt is found; resolving permanently missing receipts requires operator investigation. The UI's receipt-check action does not bypass this guard.

The real integration ends at `delivered`. It does not parse model prose into an `applied` event. The domain supports subsequent correlated outcomes, but a live outcome-reporting channel is not part of this integration. Scripted outcomes exist only in the explicit test preview.

There remains a race between the last readiness read and ACP `session/prompt` if a human writes through another Codex client at that exact moment. These locks cannot arbitrate external client input; response scope and interpretation remain with the user and agent. No exactly-once execution or exclusive control is claimed. Closing a connection cleans up its owned adapter/bridge, not the existing daemon. Codex daemon lifecycle management and enforced blocking of all external agent activity remain outside this feature.

## Existing database migration

Stop all old inbox workers and snapshot the dedicated SQLite database, including any active WAL, before enabling the new runtime. Test migration on a copy first. Do not point this at the review jobs database. Version 1 migration preserves requests, responses, recommendation flags, events, creation hashes and delivery reservations. Legacy Codex records receive the explicitly configured `legacyConnectionId`; other legacy providers remain unmapped and cannot silently target Codex. Pending legacy reservations remain uncertain until receipt reconciliation.

Migration runs in a transaction and refuses future schema versions. SQLite guards reject legacy writes that omit a connection or use the old reservation insert. These guards are defense in depth: old workers must still be stopped before migration. Reopening an upgraded database is idempotent. Do not roll back to an older snapshot after new sends, because discarding the delivery journal could cause duplicate input. Roll forward with the preserved journal or reconcile evidence before recovery.

When moving an existing static connection to an enrolled connector, use `ConnectorRuntime.adoptLegacy(legacyId, connectorId, sessions)` while the connector can answer observation requests. It verifies each original session against its recorded directory before recording an alias. The alias preserves decision bodies, creation IDs/hashes and delivery reservations; existing session locks move transactionally to the canonical connector identity. Restart with the static entry removed and confirm the pending request routes through the connector. A conflicting existing route or session lock stops migration instead of silently rebinding. Snapshot and test on a disposable copy first.

## Development and verification

The isolated preview still runs with:

```sh
LEVERFRAME_PREVIEW_ROOT=/absolute/private/preview pnpm --filter @repo/reviewer exec tsx tests/e2e/web-fixture.ts
REVIEWER_INTERNAL_URL=http://127.0.0.1:16722 pnpm --filter @repo/web exec next dev --hostname 127.0.0.1 --port 16721
```

Open `/ko/decisions` or `/en/decisions`. This fixture contains scripted scenarios; it cannot opt into live Codex execution. For real connections use `LEVERFRAME_DECISION_CONFIG` with the normal server and a separate development data directory. Existing UI response endpoints assume a private trusted-network boundary; this is not a multi-user authorization system, and the registration token is not human-answer authorization.

```sh
pnpm --filter @repo/reviewer exec vitest run tests/integration/decisions.test.ts tests/integration/decision-codex.test.ts tests/integration/decision-migration.test.ts tests/integration/decision-acp.test.ts tests/integration/connectors.test.ts
pnpm check
```

Contract tests cover storage restart, migration, later turns, cancelled sessions, explicit discard, ambiguous delivery, competing reservations, connection namespaces, protocol capabilities and transport errors. Real model and browser tests must additionally confirm question creation through the skill and reception in the same Codex conversation. Fake protocol tests alone do not establish compatibility with an installed agent version.
