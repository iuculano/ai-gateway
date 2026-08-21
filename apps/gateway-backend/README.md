# gateway-backend

The gateway itself: an authenticated HTTP API in front of the LLM providers,
recording a log, its cost and its payloads for every request that passes
through.

## Running locally

`docker-compose.yml` at the repository root runs the supporting infrastructure
only - Postgres, Valkey and MinIO. The apps are not containers in development;
they run on the host against those services.

```bash
# From the repository root - Postgres, Valkey, MinIO and the bucket init job
docker compose up -d

# Configure this app, then fill in the identity provider values
cp apps/gateway-backend/.env.example apps/gateway-backend/.env

# Apply the schema
bun run db:migrate

# This app alone, hot reloading
bun run --cwd apps/gateway-backend dev
```

`bun run dev` at the root starts every app at once through Turborepo instead.

From inside the devcontainer, use `host.docker.internal` rather than
`localhost` in `.env` - the compose services publish their ports on the host,
not inside the container.

## What it serves

`PORT` from `.env` (3000 in the example), with:

- `/v1/*` - the API. Every route authenticates, taking either a Zitadel JWT or
  an opaque `aik_` API key.
- `/open-api.json` - the generated OpenAPI 3.1 document. There is no Swagger UI
  mounted here; point a viewer at that URL.
- `/metrics` - Prometheus metrics.
- `/livez`, `/readyz` - health probes, unauthenticated.

`IDENTITY_PROVIDER_TOKEN_AUDIENCE` has no default and the process exits at
startup without it. It is the Zitadel **project** id, which is what appears in
every project token's `aud` claim - not a per-app client id.

## Tests

The integration tier needs the compose services and its own database, created
once with `bun run test:db:setup` and again after any schema change.

```bash
bun run --cwd apps/gateway-backend test:unit
bun run --cwd apps/gateway-backend test:integration
```

There is also a [stress-test harness](tests/stress/README.md) for dataset-scale
log benchmarks and HTTP load.

## Dockerfile

`Dockerfile` builds the image CI publishes to GHCR. It is not part of the local
development loop - nothing in `docker-compose.yml` builds or runs it.
