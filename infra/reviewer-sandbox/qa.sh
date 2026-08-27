#!/bin/sh
set -eu

qa_root="$(mktemp -d)"
cleanup() {
  docker ps --all --quiet --filter "label=devcontainer.local_folder=${qa_root}/container" 2>/dev/null |
    xargs --no-run-if-empty docker rm --force >/dev/null 2>&1 || true
  rm -rf "${qa_root}"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "${qa_root}/node/packages/example"
printf '%s\n' \
  '{' \
  '  "name": "sandbox-node-fixture",' \
  '  "private": true,' \
  '  "packageManager": "pnpm@11.20.0",' \
  '  "devDependencies": { "turbo": "2.10.10" },' \
  '  "scripts": { "check": "turbo run check" }' \
  '}' > "${qa_root}/node/package.json"
printf '%s\n' 'packages:' '  - packages/*' > "${qa_root}/node/pnpm-workspace.yaml"
printf '%s\n' \
  '{' \
  '  "name": "example",' \
  '  "private": true,' \
  '  "scripts": { "check": "node -e '\''process.stdout.write(process.version)'\''" }' \
  '}' > "${qa_root}/node/packages/example/package.json"
printf '%s\n' '{"tasks":{"check":{"outputs":[]}}}' > "${qa_root}/node/turbo.json"
(
  cd "${qa_root}/node"
  pnpm install --ignore-scripts --frozen-lockfile=false
  pnpm check
)

mise_node_version="$(mise exec node@22.23.2 -- node --version)"
[ "${mise_node_version}" = 'v22.23.2' ]

mkdir -p "${qa_root}/python"
printf '%s\n' \
  '[project]' \
  'name = "sandbox-python-fixture"' \
  'version = "0.0.0"' \
  'requires-python = ">=3.13"' > "${qa_root}/python/pyproject.toml"
(
  cd "${qa_root}/python"
  uv run --python 3.13 python -c 'import sys; assert sys.version_info[:2] == (3, 13)'
)

mkdir -p "${qa_root}/container/.devcontainer"
printf '%s\n' '{"image":"ubuntu:24.04"}' > "${qa_root}/container/.devcontainer/devcontainer.json"
devcontainer up --workspace-folder "${qa_root}/container" >/dev/null
devcontainer exec --workspace-folder "${qa_root}/container" test -f /etc/os-release

printf '%s\n' 'sandbox QA passed'
