ARG SANDBOX_BASE_IMAGE=docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0
FROM ${SANDBOX_BASE_IMAGE}

ARG TARGETARCH
ARG NODE_VERSION
ARG NODE_SHA256_AMD64
ARG NODE_SHA256_ARM64
ARG PNPM_VERSION
ARG PNPM_INTEGRITY
ARG MISE_VERSION
ARG MISE_SHA256_AMD64
ARG MISE_SHA256_ARM64
ARG UV_VERSION
ARG UV_SHA256_AMD64
ARG UV_SHA256_ARM64
ARG DEVCONTAINER_VERSION
ARG DEVCONTAINER_INTEGRITY

USER root

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) node_arch='x64'; node_sha256="${NODE_SHA256_AMD64}"; mise_arch='x64'; mise_sha256="${MISE_SHA256_AMD64}"; uv_arch='x86_64'; uv_sha256="${UV_SHA256_AMD64}" ;; \
      arm64) node_arch='arm64'; node_sha256="${NODE_SHA256_ARM64}"; mise_arch='arm64'; mise_sha256="${MISE_SHA256_ARM64}"; uv_arch='aarch64'; uv_sha256="${UV_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    temporary_directory="$(mktemp -d)"; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"; \
    curl --fail --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" --output "${temporary_directory}/${node_archive}"; \
    echo "${node_sha256}  ${temporary_directory}/${node_archive}" | sha256sum --check --strict; \
    tar --extract --gzip --file "${temporary_directory}/${node_archive}" --directory /usr/local --strip-components=1; \
    mise_asset="mise-v${MISE_VERSION}-linux-${mise_arch}"; \
    curl --fail --show-error --location "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${mise_asset}" --output "${temporary_directory}/mise"; \
    echo "${mise_sha256}  ${temporary_directory}/mise" | sha256sum --check --strict; \
    install -m 0755 "${temporary_directory}/mise" /usr/local/bin/mise; \
    uv_asset="uv-${uv_arch}-unknown-linux-gnu.tar.gz"; \
    curl --fail --show-error --location "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}" --output "${temporary_directory}/${uv_asset}"; \
    echo "${uv_sha256}  ${temporary_directory}/${uv_asset}" | sha256sum --check --strict; \
    tar --extract --gzip --file "${temporary_directory}/${uv_asset}" --directory "${temporary_directory}"; \
    install -m 0755 "${temporary_directory}/uv-${uv_arch}-unknown-linux-gnu/uv" /usr/local/bin/uv; \
    install -m 0755 "${temporary_directory}/uv-${uv_arch}-unknown-linux-gnu/uvx" /usr/local/bin/uvx; \
    pnpm_archive="${temporary_directory}/pnpm.tgz"; \
    curl --fail --show-error --location "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" --output "${pnpm_archive}"; \
    pnpm_expected="$(printf '%s' "${PNPM_INTEGRITY#sha512-}" | base64 --decode | od -An -vtx1 | tr -d ' \n')"; \
    pnpm_actual="$(sha512sum "${pnpm_archive}" | awk '{print $1}')"; \
    [ "${pnpm_actual}" = "${pnpm_expected}" ]; \
    npm install --global "${pnpm_archive}"; \
    devcontainer_archive="${temporary_directory}/devcontainer.tgz"; \
    curl --fail --show-error --location "https://registry.npmjs.org/@devcontainers/cli/-/cli-${DEVCONTAINER_VERSION}.tgz" --output "${devcontainer_archive}"; \
    devcontainer_expected="$(printf '%s' "${DEVCONTAINER_INTEGRITY#sha512-}" | base64 --decode | od -An -vtx1 | tr -d ' \n')"; \
    devcontainer_actual="$(sha512sum "${devcontainer_archive}" | awk '{print $1}')"; \
    [ "${devcontainer_actual}" = "${devcontainer_expected}" ]; \
    npm install --global "${devcontainer_archive}"; \
    rm -rf "${temporary_directory}" /root/.npm

ENV MISE_YES=1

COPY smoke.sh /usr/local/bin/leverframe-sandbox-smoke
COPY qa.sh /usr/local/bin/leverframe-sandbox-qa

RUN chmod 0755 /usr/local/bin/leverframe-sandbox-smoke /usr/local/bin/leverframe-sandbox-qa && \
    /usr/local/bin/leverframe-sandbox-smoke image

USER agent
