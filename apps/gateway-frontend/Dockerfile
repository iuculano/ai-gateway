# syntax=docker/dockerfile:1.7

# Build from the repository root:
# docker build -f apps/gateway-frontend/Dockerfile -t ai-gateway-frontend .
ARG BUN_VERSION=1.3.14
ARG DISTROLESS_IMAGE=gcr.io/distroless/base-debian13:nonroot

FROM oven/bun:${BUN_VERSION}-slim AS pruner
ARG TURBO_VERSION=2.10.10
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
    --minify \
    --outfile /out/gateway-frontend

FROM ${DISTROLESS_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=builder --chown=65532:65532 --chmod=0555 \
    /out/gateway-frontend /app/gateway-frontend
COPY --from=builder --chown=65532:65532 \
    /repo/apps/gateway-frontend/build/client /app/client

USER 65532:65532
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/gateway-frontend"]
