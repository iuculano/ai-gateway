# worker-webhooks

Worker for draining the webhook outbox. That's pretty much it.

On each tick it claims a batch of `webhook_outbox` rows - deleting them in the
same short transaction that selects them - then POSTs `{ webhook_id, log_id }`
to each webhook's endpoint and records the status code in `webhook_deliveries`.

A delivery is attempted once. There is no retry - a row leaves the outbox
before the POST is even made, and the attempt survives only as history. That is
a deliberate at-most-once trade: nothing is held while the HTTP calls happen,
so one dead endpoint cannot stall the queue behind it, but a crash mid-batch
loses those notifications.

A request with no response at all - DNS failure, connection refused, or the
`WORKER_DELIVERY_TIMEOUT_MS` timeout - is recorded with status code `0`.

## Running locally

`docker-compose.yml` at the repository root runs the supporting infrastructure
only - Postgres, Valkey and MinIO. The apps are not containers in development;
they run on the host against those services.

This worker needs Postgres and nothing else.

```bash
# From the repository root
docker compose up -d

# There is no .env.example for this app; a connection string is the only
# required value
echo 'POSTGRES_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/ai_gateway' > apps/worker-webhooks/.env

bun run --cwd apps/worker-webhooks dev
```

From inside the devcontainer, use `host.docker.internal` rather than
`localhost` in that connection string - the compose services publish their
ports on the host, not inside the container.

## What it serves

`PORT` from `.env` (3000 by default), with:

- `/livez` - liveness probe, unauthenticated.
- `/readyz` - readiness. Checks Postgres connectivity and that the expected
  tables exist; 503 when either fails.
- `/open-api.json`, `/docs` - the generated OpenAPI 3.1 document and a Swagger
  UI over it.

## Configuration

`POSTGRES_CONNECTION_STRING` is the only required variable, and the process
exits at startup without it. Everything else has a default.

| Variable                     | Default       |                                         |
| ---------------------------- | ------------- | --------------------------------------- |
| `POSTGRES_CONNECTION_STRING` | none          | Required, must parse as a URL           |
| `WORKER_ENABLED`             | `true`        | `false` starts the process without the drain |
| `WORKER_POLL_INTERVAL_MS`    | `10000`       | How often a batch is claimed            |
| `WORKER_BATCH_SIZE`          | `25`          | Rows per tick, claimed with `FOR UPDATE SKIP LOCKED` |
| `WORKER_DELIVERY_TIMEOUT_MS` | `10000`       | Per-delivery HTTP timeout               |
| `NODE_ENV`                   | `development` |                                         |
| `LOG_LEVEL`                  | `info`        |                                         |
| `PORT`                       | `3000`        | Health and docs endpoints only          |

It takes no discrete host/database/credential variables: `POSTGRES_ENDPOINT`
and friends are not keys this app reads, and setting them has no effect.

A tick that is still running when the next one is due is skipped rather than
overlapped, so a slow batch does not pile ticks on top of each other.

## Dockerfile

`Dockerfile` builds the image CI publishes to GHCR. It is not part of the local
development loop - nothing in `docker-compose.yml` builds or runs it.
