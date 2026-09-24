FROM node:24.13.0-bookworm@sha256:1de022d8459f896fff2e7b865823699dc7a8d5567507e8b87b14a7442e07f206 AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/reviewer/package.json apps/reviewer/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

COPY apps/reviewer ./apps/reviewer
COPY apps/web ./apps/web
COPY packages ./packages
RUN pnpm --filter @repo/reviewer build \
  && pnpm --filter @repo/reviewer deploy --prod /app/reviewer-runtime \
  && pnpm --filter @repo/web build

# Next standalone tracing omits ESM files behind pnpm's @swc/helpers symlink.
RUN swc_helpers_source="$(find /app/node_modules/.pnpm -type d -path '*/node_modules/@swc/helpers' -print -quit)" \
  && test -n "$swc_helpers_source" \
  && swc_helpers_relative="${swc_helpers_source#/app/node_modules/}" \
  && swc_helpers_destination="/app/apps/web/.next/standalone/node_modules/${swc_helpers_relative}" \
  && mkdir -p "$swc_helpers_destination" \
  && cp -a "$swc_helpers_source/esm" "$swc_helpers_destination/"

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS reviewer

ENV NODE_ENV=production
WORKDIR /app/apps/reviewer

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/reviewer-runtime/ ./

USER node
EXPOSE 6571

CMD ["node", "dist/cli.js", "serve"]

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS web

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=6572
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /app/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=build --chown=node:node /app/apps/web/public/ ./apps/web/public/

USER node
EXPOSE 6572

CMD ["node", "apps/web/server.js"]
