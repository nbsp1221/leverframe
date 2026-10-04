#!/bin/sh
# User-local Linux connector install. No sudo, system service or shell profile changes.
set -eu
command -v node >/dev/null || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required for the question skill.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'This connector build currently supports Linux Codex Desktop environments.' >&2; exit 1; }
core=${1:?Leverframe URL required}
code=${2:?Pairing code required}
root=${LEVERFRAME_CONNECTOR_HOME:-"$HOME/.local/share/leverframe-connector"}
umask 077
mkdir -p "$root"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https,http' "$core/api/v1/connectors/download/connector.tar.gz" -o "$archive"
mkdir -p "$root/bin"
tar -xzf "$archive" -C "$root/bin"
node "$root/bin/connector.js" connect --url "$core" --code "$code"
node "$root/bin/connector.js" start
