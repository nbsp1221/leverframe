#!/bin/sh
set -eu

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
. "${script_directory}/versions.env"

image="${1:?usage: build.sh IMAGE [PLATFORM]}"
platform="${2:-linux/amd64}"

docker buildx build \
  --build-arg "SANDBOX_BASE_IMAGE=${SANDBOX_BASE_IMAGE}" \
  --build-arg "NODE_VERSION=${NODE_VERSION}" \
  --build-arg "NODE_SHA256_AMD64=${NODE_SHA256_AMD64}" \
  --build-arg "NODE_SHA256_ARM64=${NODE_SHA256_ARM64}" \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --build-arg "PNPM_INTEGRITY=${PNPM_INTEGRITY}" \
  --build-arg "MISE_VERSION=${MISE_VERSION}" \
  --build-arg "MISE_SHA256_AMD64=${MISE_SHA256_AMD64}" \
  --build-arg "MISE_SHA256_ARM64=${MISE_SHA256_ARM64}" \
  --build-arg "UV_VERSION=${UV_VERSION}" \
  --build-arg "UV_SHA256_AMD64=${UV_SHA256_AMD64}" \
  --build-arg "UV_SHA256_ARM64=${UV_SHA256_ARM64}" \
  --build-arg "DEVCONTAINER_VERSION=${DEVCONTAINER_VERSION}" \
  --build-arg "DEVCONTAINER_INTEGRITY=${DEVCONTAINER_INTEGRITY}" \
  --file "${script_directory}/Dockerfile" \
  --label 'org.opencontainers.image.source=https://github.com/nbsp1221/leverframe' \
  --load \
  --platform "${platform}" \
  --tag "${image}" \
  "${script_directory}"
