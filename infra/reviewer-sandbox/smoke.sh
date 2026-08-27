#!/bin/sh
set -eu

expected_node='v24.20.0'
expected_pnpm='11.20.0'
expected_mise='2026.8.14'
expected_uv='0.12.6'
expected_devcontainer='0.88.0'

node_version="$(node --version)"
pnpm_version="$(pnpm --version)"
mise_version="$(mise --version | awk '{print $1}')"
uv_version="$(uv --version | awk '{print $2}')"
devcontainer_version="$(devcontainer --version)"

[ "${node_version}" = "${expected_node}" ]
[ "${pnpm_version}" = "${expected_pnpm}" ]
[ "${mise_version}" = "${expected_mise}" ]
[ "${uv_version}" = "${expected_uv}" ]
[ "${devcontainer_version}" = "${expected_devcontainer}" ]
command -v codex >/dev/null

printf 'node=%s\n' "${node_version}"
printf 'pnpm=%s\n' "${pnpm_version}"
printf 'mise=%s\n' "${mise_version}"
printf 'uv=%s\n' "${uv_version}"
printf 'devcontainer=%s\n' "${devcontainer_version}"
printf 'codex=%s\n' "$(codex --version | head -n 1)"

if [ "${1:-image}" = 'sandbox' ]; then
  sudo -n true
  docker info >/dev/null
  if grep -E '/home/agent/(\.agents|\.claude|\.codex)/skills([ /]|$)' /proc/self/mountinfo >/dev/null; then
    echo 'shared agent skills mount detected' >&2
    exit 1
  fi
  printf 'sudo=available\n'
  printf 'docker=%s\n' "$(docker version --format '{{.Server.Version}}')"
  printf 'shared_skills=disabled\n'
fi
