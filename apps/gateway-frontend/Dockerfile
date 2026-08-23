# syntax=docker/dockerfile:1.7

# Build from the repository root:
# docker build -f apps/gateway-frontend/Dockerfile -t ai-gateway-frontend .
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
    bunx turbo@${TURBO_VERSION} prune gateway-frontend --docker

FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /repo

COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
RUN bun run --cwd apps/gateway-frontend build
RUN bun build apps/gateway-frontend/build/index.js \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --outfile /out/gateway-frontend

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8081
WORKDIR /app

COPY --from=builder --chown=65532:65532 --chmod=0555 \
    /out/gateway-frontend /app/gateway-frontend
COPY --from=builder --chown=65532:65532 \
    /repo/apps/gateway-frontend/build/client /app/client

USER 65532:65532
EXPOSE 8081
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/gateway-frontend"]
