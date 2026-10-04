# Decision requests

The request inbox separates a human response, its delivery to the original agent conversation, and a report that the decision was applied. Research is not implementation approval. Receiving a response is not evidence of successful implementation.

## Architecture

`DecisionService` owns revisions, response idempotency and state transitions. `SessionDecisionGateway` builds the scoped response, checks the original checkpoint and reconciles delivery receipts. These application modules depend on ports, not ACP, Codex RPC, sockets, subprocesses or SQLite implementations.

`agent-connections/ports.ts` defines a session observer and prepared message channel. A connection ID namespaces session IDs, which are opaque strings rather than globally unique Codex UUIDs. The observer reports readiness, checkpoint and received messages. `AcpSessionChannel` implements the channel with the pinned ACP TypeScript SDK, using stdio or the SDK's experimental WebSocket transport. Adding an agent requires a channel and an observer that can establish the necessary evidence; merely accepting ACP prompts is insufficient for safe retry.

`createDecisionRuntime` is the normal application composition root. It constructs connections, storage and the persistent delivery worker without importing fixtures. `leverframe serve` enables it when `LEVERFRAME_DECISION_CONFIG` points to a configuration file. Without that setting, inbox endpoints return 503. The existing review/development execution engines are not migrated by this feature.

The Codex Desktop profile uses pinned `codex-acp`, the supplied `codex-desktop-bridge.sh`, and an operator-provided local `websocat` executable. The wrapper attaches to an existing Desktop daemon; it never starts a replacement daemon. The adapter sends through ACP only. A separate read-only Codex observer uses `thread/read` and `thread/loaded/list` to check identity, turn state and receipts, because ACP v1 does not provide those guarantees. There is no native sender fallback. The profile depends on the installed Codex daemon's experimental direct-input fields and Unix WebSocket compatibility.

## Configure a local connection

Keep configuration, bearer tokens and the dedicated inbox database outside Git. Restrict configuration/token files to the service user. Paths must be absolute. Install dependencies with the repository lockfile; no global ACP install is needed. Provide `websocat` separately and make the bundled bridge executable. The build also copies the bridge to `apps/reviewer/dist/codex-desktop-bridge.sh`.

Example server configuration (replace paths and the allowed session ID):

```json
{
  "version": 1,
  "databasePath": "/private/leverframe/inbox.sqlite",
  "tokenFile": "/private/leverframe/registration-token",
  "legacyConnectionId": "desktop-local",
  "connections": [
    {
      "id": "desktop-local",
      "agentId": "codex",
      "sessions": { "existing-session-id": "/workspace/project" },
      "observer": {
        "kind": "codex-desktop",
        "socketPath": "/private/codex/app-server-control.sock"
      },
      "transport": {
        "kind": "codex-desktop",
        "bridgePath": "/opt/leverframe/apps/reviewer/dist/codex-desktop-bridge.sh",
        "websocatPath": "/opt/tools/websocat"
      }
    }
  ]
}
```

The token must have at least 32 characters. The session allowlist binds each session to its actual working directory. New sessions require explicit configuration; the service does not automatically claim every conversation on the device. The observer currently needs local access to the Desktop socket. Remote transport support does not itself install a remote observer or device enrollment service.

A transport can instead be `{ "kind": "stdio", "command": "/absolute/agent", "args": [], "env": {} }`, or `{ "kind": "websocket", "url": "ws://127.0.0.1:18781/acp/ws", "tokenFile": "/private/remote-token" }` for a compatible endpoint such as acpremote. Use `wss` for remote hosts or a loopback SSH tunnel. Token files are read at connection time; tokens are never part of the URL. Endpoint authorization remains the endpoint operator's responsibility. The business service does not change when switching transports. Other agent observers are an extension point, not a claim of implemented Claude/local-model support.

## Agent skill and API

The bundled `.agents/skills/leverframe-ask/SKILL.md` uses a Python 3 script without external dependencies. Supply a separate agent configuration with `url` (backend), `uiUrl` (request workspace), `token` (registration bearer) and `connectionId` (such as `desktop-local`). Pass its path with `--config` or `LEVERFRAME_AGENT_CONFIG`; never paste its secret contents into a prompt. Point an external test conversation to the skill's absolute path. Repository-local discovery does not install it globally.

The script reads `LEVERFRAME_SESSION_ID`, falling back to `CODEX_THREAD_ID`, and submits `source: { connectionId, sessionId }` plus a stable question key. It does not allow the question file to override the source. Legacy configuration without `connectionId` still sends the previous `threadId` format; the server maps that only to `legacyConnectionId`. Plain HTTP is restricted to loopback, redirects and environment proxies are disabled, and credentials are not printed.

`POST /api/v1/decisions` requires the registration bearer. It accepts question content, a source and `key`; the server derives the originating checkpoint from the allowed actual conversation. A duplicate key and payload return the existing request across restarts. Changed content under the same key returns 409. New identities include the connection namespace. Legacy creation identities and hashes are preserved. OpenAPI, `/docs` and `/llms.txt` describe the same contract.

Every new question includes exactly one recommended option with a reason, or explicitly states why the evidence cannot support a recommendation. The UI marks that option without choosing it for the user. Question scope remains visible; supporting evidence and event history can be expanded. Unsent drafts stay in the browser tab. Deferring a question schedules its visibility, not permission to execute.

For a blocking question the skill tells the agent to stop dependent work and finish the turn normally. A response returns as a new message in the original conversation. For nonblocking questions the agent may continue only independently authorized work. A changed original checkpoint stops delivery. This conservative behavior can defer a nonblocking response that needs renewed context; the service does not inject into arbitrary active work.

## Delivery and recovery

Saving an answer and creating its delivery outbox row are one SQLite transaction. The worker processes persisted rows after restart. Session locks serialize different deliveries to the same connection/session. A stable delivery ID and payload hash are reserved before sending. Competing workers can observe the same delivery, but only one can reserve its first send.

The gateway checks the actual conversation before loading the adapter and immediately before sending. Busy or disconnected targets remain in follow-up with specific explanations and are checked automatically. A cancelled or changed original task becomes superseded. Missing ACP load support is reported as unsupported; no replacement conversation is created. Additional tool permission requests received through ACP are denied, not automatically approved; this integration is not a general approval forwarding UI.

After sending, the observer must find the exact response in the original conversation to confirm delivery. A successful ACP prompt alone is insufficient. If the network response is lost, a later receipt check can recover without resending. A reservation without a receipt remains unconfirmed, including after restart and manual retry. Failure to find a message is not proof that resending is safe. An ambiguous delivery holds its session lock until its receipt is found; resolving permanently missing receipts requires operator investigation. The UI's receipt-check action does not bypass this guard.

The real integration ends at `delivered`. It does not parse model prose into an `applied` event. The domain supports subsequent correlated outcomes, but a live outcome-reporting channel is not part of this integration. Scripted outcomes exist only in the explicit test preview.

There remains a race between the last observer read and ACP `session/prompt` if a human writes in the Desktop app at that exact moment. ACP v1 does not expose atomic compare-checkpoint-and-send, and these locks cannot arbitrate external app input. No exactly-once execution or exclusive control is claimed. Closing a connection cleans up its owned adapter/bridge, not the existing daemon. Unloaded-session recovery, device enrollment, daemon lifecycle management and enforced blocking of all external agent activity remain outside this feature.

## Existing database migration

Stop all old inbox workers and snapshot the dedicated SQLite database, including any active WAL, before enabling the new runtime. Test migration on a copy first. Do not point this at the review jobs database. Version 1 migration preserves requests, responses, recommendation flags, events, creation hashes and delivery reservations. Legacy Codex records receive the explicitly configured `legacyConnectionId`; other legacy providers remain unmapped and cannot silently target Codex. Pending legacy reservations remain uncertain until receipt reconciliation.

Migration runs in a transaction and refuses future schema versions. SQLite guards reject legacy writes that omit a connection or use the old reservation insert. These guards are defense in depth: old workers must still be stopped before migration. Reopening an upgraded database is idempotent. Do not roll back to an older snapshot after new sends, because discarding the delivery journal could cause duplicate input. Roll forward with the preserved journal or reconcile evidence before recovery.

## Development and verification

The isolated preview still runs with:

```sh
LEVERFRAME_PREVIEW_ROOT=/absolute/private/preview pnpm --filter @repo/reviewer exec tsx tests/e2e/web-fixture.ts
REVIEWER_INTERNAL_URL=http://127.0.0.1:16722 pnpm --filter @repo/web exec next dev --hostname 127.0.0.1 --port 16721
```

Open `/ko/decisions` or `/en/decisions`. This fixture contains scripted scenarios; it cannot opt into live Codex execution. For real connections use `LEVERFRAME_DECISION_CONFIG` with the normal server and a separate development data directory. Existing UI response endpoints assume a private trusted-network boundary; this is not a multi-user authorization system, and the registration token is not human-answer authorization.

```sh
pnpm --filter @repo/reviewer exec vitest run tests/integration/decisions.test.ts tests/integration/decision-codex.test.ts tests/integration/decision-migration.test.ts tests/integration/decision-acp.test.ts
pnpm check
```

Contract tests cover storage restart, migration, stale/cancelled origins, ambiguous delivery, competing reservations, connection namespaces, protocol capabilities and transport errors. Real model and browser tests must additionally confirm question creation through the skill and reception in the same Desktop conversation. Fake protocol tests alone do not establish compatibility with an installed agent version.
