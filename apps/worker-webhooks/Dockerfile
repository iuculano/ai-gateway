# syntax=docker/dockerfile:1.7

# Build from the repository root:
# docker build -f apps/worker-webhooks/Dockerfile -t ai-gateway-worker-webhooks .
ARG BUN_VERSION=1.3.14
ARG DISTROLESS_IMAGE=gcr.io/distroless/base-debian13:nonroot

FROM oven/bun:${BUN_VERSION}-slim AS pruner
ARG TURBO_VERSION=2.10.10
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bunx turbo@${TURBO_VERSION} prune worker-webhooks --docker

FROM oven/bun:${BUN_VERSION}-slim AS builder
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY --from=pruner /repo/out/full/ .
RUN bun build apps/worker-webhooks/src/index.ts \
    --compile \
    --minify \
    --outfile /out/worker-webhooks

FROM ${DISTROLESS_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=builder --chown=65532:65532 --chmod=0555 \
    /out/worker-webhooks /app/worker-webhooks

USER 65532:65532
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/worker-webhooks"]
