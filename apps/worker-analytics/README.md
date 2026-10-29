# worker-analytics

Syncs the gateway `logs` table from Postgres to ClickHouse.

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/worker-analytics dev
```

## Configuration

The application can be configured via environment variables.

| Variable                     | Default                 | Description                            |
| ---------------------------- | ----------------------- | -------------------------------------- |
| `NODE_ENV`                   | `development`           | `development`, `production`, or `test` |
| `POSTGRES_CONNECTION_STRING` | Required                | PostgreSQL connection URL              |
| `CLICKHOUSE_URL`             | `http://localhost:8123` | ClickHouse HTTP endpoint               |
| `CLICKHOUSE_USER`            | `default`               | ClickHouse user                        |
| `CLICKHOUSE_PASSWORD`        | Empty                   | `clickhouse` for the compose service   |
| `CLICKHOUSE_DATABASE`        | `ai_gateway`            | ClickHouse database                    |
| `PORT`                       | `8084`                  | HTTP server port                       |
| `LOG_LEVEL`                  | `info`                  | Log verbosity                          |
| `WORKER_ENABLED`             | `true`                  | Set to `false` to disable processing   |
| `WORKER_POLL_INTERVAL_MS`    | `10000`                 | Time between syncs                     |
| `SYNC_BATCH_ROWS`            | `20000`                 | Rows per INSERT into ClickHouse        |

ClickHouse is configured to keeps the table's data in object storage with a
local disk cache: see `infra/clickhouse/storage.xml`.

Each tick reads the latest ClickHouse log, then reads a batch from Postgres at
that point in time, and finally inserts into ClickHouse.

## Tests

```bash
# Run it from the repository root so the harness can bring up what is needed.
bun run test:integration
```
