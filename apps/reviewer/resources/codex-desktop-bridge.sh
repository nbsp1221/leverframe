#!/bin/sh
# codex-acp CODEX_PATH profile: attach only to the configured existing daemon.
set -eu
[ "${1:-}" = app-server ] || { echo 'Only app-server attachment is supported' >&2; exit 64; }
: "${LEVERFRAME_CODEX_SOCKET:?Codex app-server Unix socket is required}"
: "${LEVERFRAME_WEBSOCAT_PATH:?Local websocat executable is required}"
exec "$LEVERFRAME_WEBSOCAT_PATH" -E -t --buffer-size=33554432 --ws-c-uri=ws://localhost/ - "ws-c:unix:$LEVERFRAME_CODEX_SOCKET"
