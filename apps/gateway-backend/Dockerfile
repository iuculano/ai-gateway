# syntax=docker/dockerfile:1.7

# Build from the repository root:
# docker build -f apps/gateway-backend/Dockerfile -t ai-gateway-backend .
ARG BUN_VERSION=1.4.0
# Chainguard's free tier publishes :latest only and rebuilds it daily, so this
# tag moves under us - two builds a week apart can sit on different glibc. Mirror
# a digest into GHCR and point this at that if builds need to be reproducible.
ARG RUNTIME_IMAGE=cgr.dev/chainguard/glibc-dynamic:latest

FROM oven/bun:${BUN_VERSION}-slim AS pruner
ARG TURBO_VERSION=2.10.11
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bunx turbo@${TURBO_VERSION} prune gateway-backend --docker

FROM oven/bun:${BUN_VERSION}-slim AS builder
ENV NODE_ENV=production
WORKDIR /repo

# The manifests first, so a change to application source does not reinstall the
# dependency tree. turbo prune emits out/json for exactly this.
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY --from=pruner /repo/out/full/ .
RUN bun run --cwd apps/gateway-backend build

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=builder --chown=65532:65532 --chmod=0555 \
    /repo/apps/gateway-backend/dist/gateway-backend /app/gateway-backend

USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/gateway-backend"]
