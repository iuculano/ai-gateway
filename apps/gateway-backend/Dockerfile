ARG BUN_VERSION=1.4.2
ARG RUNTIME_IMAGE=cgr.dev/chainguard/glibc-dynamic:latest

#-------------------------------------------------------------------------------
# Prune the repository to only include the necessary files for the
# gateway-backend app.
#
# https://turborepo.dev/docs/reference/prune
#-------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS pruner
ARG  TURBO_VERSION=2.10.11
ENV  TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

COPY . .
RUN bunx turbo@${TURBO_VERSION} prune gateway-backend --docker

#-------------------------------------------------------------------------------
# Install runtime dependencies and compile the app into an executable
# containing the application code and Bun runtime.
#
# https://turborepo.dev/docs/guides/tools/docker#example
#-------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS builder
ENV NODE_ENV=production
WORKDIR /repo

# Copies are split so Docker can reuse dependencies when only source changes.
COPY --from=pruner /repo/out/json/ .
RUN bun install --frozen-lockfile --production

COPY --from=pruner /repo/out/full/ .
RUN bun run --cwd apps/gateway-backend build

#-------------------------------------------------------------------------------
# The final image - runs as non-root.
#-------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runner
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY --from=builder --chown=65532:65532 --chmod=0555 \
  /repo/apps/gateway-backend/dist/gateway-backend /app/gateway-backend

USER       65532:65532
EXPOSE     8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/gateway-backend"]
