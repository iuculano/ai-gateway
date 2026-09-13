ARG BUN_VERSION=1.4.2
ARG RUNTIME_IMAGE=cgr.dev/chainguard/glibc-dynamic:latest

#-------------------------------------------------------------------------------
# Prune the repository to only include the necessary files for the
# gateway-frontend app.
#
# https://turborepo.dev/docs/reference/prune
#-------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS pruner
ARG  TURBO_VERSION=2.10.11
ENV  TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

COPY . .
RUN bunx turbo@${TURBO_VERSION} prune gateway-frontend --docker

#-------------------------------------------------------------------------------
# Install dependencies, including build tools, and build SvelteKit.
#
# https://turborepo.dev/docs/guides/tools/docker#example
#-------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /repo

# Copies are split so Docker can reuse dependencies when only source changes.
COPY --from=pruner /repo/out/json/ .
RUN bun install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
RUN bun run --cwd apps/gateway-frontend build

#-------------------------------------------------------------------------------
# Only the actual needed runtime dependencies.
#-------------------------------------------------------------------------------
FROM    oven/bun:${BUN_VERSION}-slim AS production-dependencies
WORKDIR /repo

COPY --from=pruner /repo/out/json/ .

RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=pruner /repo/out/full/packages/ ./packages/

#-------------------------------------------------------------------------------
# The final image - runs as non-root.
#-------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8081

WORKDIR /app/apps/gateway-frontend

COPY --from=production-dependencies --chown=65532:65532 --chmod=0555 \
  /usr/local/bin/bun /usr/local/bin/bun

COPY --from=production-dependencies --chown=65532:65532 /repo/node_modules/ /app/node_modules/
COPY --from=production-dependencies --chown=65532:65532 /repo/packages/ /app/packages/
COPY --from=production-dependencies --chown=65532:65532 /repo/apps/gateway-frontend/ ./

COPY --from=builder --chown=65532:65532 \
  /repo/apps/gateway-frontend/build/ ./build/

USER       65532:65532
EXPOSE     8081
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/bun", "run", "/app/apps/gateway-frontend/build/index.js"]
