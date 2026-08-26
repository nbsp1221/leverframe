# Leverframe

Leverframe is a local-first control plane for running AI work loops to verified completion.

Frame the work. Let the system carry the loop.

The first vertical slice is intentionally narrow:

```text
pull request event
  -> isolated Codex review
  -> validated findings
  -> GitHub review
```

Code review is the first experiment, not the product boundary. The longer-term goal is to coordinate agents and humans across execution, verification, retry, and handoff steps until work is done, failed, cancelled, or needs a person.

## Project status

The first private-repository vertical loop is operational: a GitHub App webhook can create a durable job, run the configured reviewer inside a disposable Docker Sandbox, and publish a review as `leverframe[bot]`. This remains an experimental single-operator MVP and is not ready for production repositories.

## Development

Requirements:

- Node.js 24 or newer
- pnpm 11
- Docker Engine and Docker Sandboxes (`sbx`)
- An immutable review sandbox template built from `infra/reviewer-sandbox/`

Install and validate the current skeleton:

```sh
corepack pnpm install
corepack pnpm --filter @repo/web exec playwright install chromium
corepack pnpm check
```

Run the development CLI:

```sh
corepack pnpm dev -- --help
```

## Configuration

Copy the public example and set the GitHub account ID, private operator UI URL, and exact public webhook URL (including `/webhooks/github`) for your installation:

```sh
cp .env.example .env
```

Runtime state, GitHub App credentials, and review artifacts live under the ignored `.leverframe/` directory by default. Environment variables are grouped by responsibility rather than product name: `APP_*` controls the process, `GITHUB_*` controls the integration, and `REVIEW_*` controls review execution.

`REVIEW_SANDBOX_TEMPLATE` is required and must be a fully qualified OCI reference with a `sha256` digest. Leverframe does not fall back to Docker Sandbox's mutable default template. The template provides pinned baseline tools while Codex remains responsible for selecting repository-specific runtimes from project evidence.

The quality-first review defaults are `gpt-5.6-sol` with `high` reasoning. Model capacity or execution failures are reported as failed review jobs; Leverframe does not silently switch to another model.

Tests are separated by execution boundary:

- `tests/unit` contains deterministic policy and transformation tests.
- `tests/integration` exercises SQLite, files, HTTP, and process boundaries.
- `tests/e2e` launches the executable entry point as an external process.

Each group has a matching `test:unit`, `test:integration`, or `test:e2e` script for CI.

## Architecture

Source modules are grouped by the responsibility that changes them:

```text
src/
├─ cli.ts       composition root and executable entry point
├─ app/         configuration and HTTP server
├─ github/      GitHub App credentials, API, manifest, and webhooks
├─ jobs/        durable state, commands, and review orchestration
├─ review/      review policy, results, history, and publication rules
├─ sandbox/     disposable Codex execution and recovery
└─ system/      operating-system process boundary
```

Imports remain explicit rather than using barrel exports. The `review` modules do not depend on job storage or the GitHub client; adapters consume their contracts instead.

## Deployment

The deployment boundary is:

```text
GitHub -> public Caddy webhook route (`leverframe-api.retn0.dev`) -> reviewer
Tailnet operator -> private Caddy route (`leverframe.retn0.dev`) -> web / reviewer API
reviewer -> host sandboxd Unix socket -> disposable Codex Docker Sandbox
```

Docker Compose provides a reproducible Leverframe process, health reporting, and restart policy. The trusted host `sandboxd` daemon remains the execution bridge because it owns Docker Sandbox lifecycle and operator-managed Codex OAuth. The Leverframe container does not receive the host Docker socket.

Validate and start the service:

```sh
docker compose config --quiet
docker compose build reviewer web
docker compose up -d
docker compose ps
```

Compose runs two independently healthy services: the reviewer listens on internal port `6571`, and the Next.js web app listens on internal port `6572`. The default host bindings are loopback-only (`REVIEWER_PORT=6571` and `WEB_PORT=6572`); set the corresponding `*_BIND_ADDRESS` values only when the deployment boundary requires it. The web service is intentionally not blocked on reviewer health, so it can show its degraded backend state while the reviewer recovers.

Runtime state stays with the checkout in `.leverframe/`; no root-owned directory or system-wide application path is required. Only the reviewer mounts the data directory, sandbox CLI/configuration, and sandbox daemon state. The data directory is mounted at the same absolute path because the host `sandboxd` daemon must be able to resolve per-job anchor and resource paths created by the reviewer container. The web container receives no GitHub credentials, sandbox mounts, or data volume. Private repository contents are still cloned only inside the disposable Sandbox.

This MVP intentionally has no application-level authentication. Keep the UI, API, and setup flow behind an operator-controlled private network such as Tailscale; anyone who can reach them can read review artifacts and change evaluations. The public GitHub host must expose only the exact webhook endpoint. It must not expose the UI, API, or setup routes.

## Review API

The web UI and external tools use the same versioned review API and evaluation revisions. Leverframe does not provide a separate agent API or run an approval workflow. An external agent can inspect a completed review, propose judgments to a human, and use the documented evaluation endpoints after the human approves the result.

The private deployment serves three views of the same contract:

- `/openapi.json` for machines and client generation
- `/docs` for the Scalar interactive reference
- `/llms.txt` for LLM-friendly Markdown generated from the OpenAPI document

The Scalar browser bundle is version-pinned and served by Leverframe itself. The documentation UI does not depend on a remote script, external fonts, telemetry, or Scalar registry requests at runtime.

A write client should read `GET /api/v1/reviews/{reviewId}/evaluations`, pass the current revision as `expected_previous_id`, and handle `409 STALE_EVALUATION` by presenting the newer revision for renewed human review. If a response is lost, read the history again instead of blindly repeating the write. Evaluation history is append-only, and withdrawals add a revision rather than deleting prior judgments.

The generated contract documents the complete read and evaluation surface. Review execution, cancellation, retry, authentication, CORS, CLI, and MCP are intentionally outside this API version.

```caddy
app.example.com {
    @not-tailnet not remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
    handle @not-tailnet {
        respond 403
    }

    @reviewer path /api/* /healthz /setup/github* /openapi.json /docs /docs/* /llms.txt
    handle @reviewer {
        reverse_proxy reviewer:6571
    }
    handle {
        reverse_proxy web:6572
    }
}

api.example.com {
    @github_webhook {
        method POST
        path /webhooks/github
    }
    handle @github_webhook {
        reverse_proxy reviewer:6571
    }
    handle {
        respond 404
    }
}
```

The repository does not modify or reload an operating Caddy configuration. For local testing, the ignored `compose.override.yaml` connects both services to the existing external `caddy-network`; verify that network and the current Caddy aliases before use. Keep any host-specific Caddy file outside this repository or in an ignored local deployment directory.

Before changing an operating Caddy route, save a backup, run `caddy validate --config <config>`, and inspect the rendered route priority. After explicit approval, use a graceful reload and smoke test both `https://<host>/en/reviews` and same-origin `/api/v1/status`; also verify an existing virtual host before and after the reload. Do not stop the Caddy container or reload unrelated virtual hosts. The sandbox daemon directory is mounted read-only rather than binding only the socket file, so a daemon restart can replace the socket without leaving the reviewer attached to a stale inode. Starting and supervising the host `sandboxd` process is an infrastructure prerequisite and is intentionally outside Leverframe's deployment scope.

The reviewer requires Docker Sandboxes 0.39.0 or newer. At service startup it creates and removes a disposable canary using the configured digest, verifies the pinned baseline, sudo, the private Docker Engine, and shared-skill isolation, and starts the review worker only after that preflight succeeds.

Build a local template for inspection with:

```sh
infra/reviewer-sandbox/build.sh leverframe-review-sandbox:local
docker run --rm --entrypoint /usr/local/bin/leverframe-sandbox-smoke leverframe-review-sandbox:local image
```

The `Publish review sandbox template` workflow is manual because publishing an OCI package is an explicit release action. It builds the pinned inputs, runs the image smoke test and vulnerability scan, then publishes to GHCR. Copy the resulting immutable digest into `.env`; do not use the workflow's convenience tag at runtime. For a non-Docker Hub private registry, configure host-side Sandbox registry credentials instead of placing them in Compose or the image.

Before an image or schema upgrade, stop only the reviewer so SQLite closes cleanly, copy every `state.sqlite*` file to a timestamped directory, and record checksums. Keep the previous image and Compose file until the upgraded reviewer, web UI, and representative review artifacts have passed smoke tests.

```sh
set -a
. ./.env
set +a
backup_directory="${APP_DATA_DIRECTORY}/backups/$(date +%Y%m%d-%H%M%S)"
docker compose stop reviewer
mkdir -p "$backup_directory"
cp -a "${APP_DATA_DIRECTORY}"/state.sqlite* "$backup_directory"/
sha256sum "$backup_directory"/state.sqlite* > "$backup_directory/SHA256SUMS"
docker compose up -d reviewer
```

To roll back, stop the reviewer again, verify `SHA256SUMS`, restore the saved `state.sqlite*` files, restore the previous image and Compose file, and then start the reviewer. Migrations 2 and 3 are additive, but the database backup remains the authoritative recovery point; never run a destructive downgrade against the only copy.

## License

[MIT](LICENSE)
