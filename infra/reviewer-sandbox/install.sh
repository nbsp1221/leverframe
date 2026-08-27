#!/bin/sh
set -eu

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
build_image='leverframe-review-sandbox:build'
platform="${1:-}"
temporary_directory="$(mktemp -d)"
content_tag=''

cleanup() {
  if [ -n "${content_tag}" ]; then
    docker image rm "${content_tag}" >/dev/null 2>&1 || true
  fi
  docker image rm "${build_image}" >/dev/null 2>&1 || true
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT HUP INT TERM

if [ -n "${platform}" ]; then
  "${script_directory}/build.sh" "${build_image}" "${platform}"
else
  "${script_directory}/build.sh" "${build_image}"
fi

image_id="$(docker image inspect --format '{{.Id}}' "${build_image}")"
content_tag="leverframe-review-sandbox:sha256-${image_id#sha256:}"
docker image tag "${build_image}" "${content_tag}"
docker image save --output "${temporary_directory}/template.tar" "${content_tag}"
sbx template load "${temporary_directory}/template.tar"

printf 'REVIEW_SANDBOX_TEMPLATE=%s\n' "${content_tag}"
