# worker-analytics-rollup

Keeps `analytics_hourly` in step with `logs`.

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/worker-analytics-rollup dev
```

## Configuration

The application can be configured via environment variables.

| Variable                       | Default       | Description                            |
| ------------------------------ | ------------- | -------------------------------------- |
| `NODE_ENV`                     | `development` | `development`, `production`, or `test` |
| `POSTGRES_CONNECTION_STRING`   | Required      | PostgreSQL connection URL              |
| `PORT`                         | `8084`        | HTTP server port                       |
| `LOG_LEVEL`                    | `info`        | Log verbosity                          |
| `WORKER_ENABLED`               | `true`        | Set to `false` to disable processing   |
| `WORKER_POLL_INTERVAL_MS`      | `300000`      | Time between polls                     |
| `ROLLUP_TRAILING_WINDOW_HOURS` | `3`           | Recent hours refreshed each poll       |
| `ROLLUP_CHUNK_HOURS`           | `24`          | Hours refreshed per query              |

Each tick rewinds `ROLLUP_TRAILING_WINDOW_HOURS` behind the newest bucket and
recomputes forward, so a log that arrived late still lands in its own hour. The
refresh is idempotent, and the current hour is never written - it is still
changing, and the dashboard reads it live from `logs`.

## Tests

```bash
# Unit.
bun run --cwd apps/worker-analytics-rollup test:unit

# Integration. Run it from the repository root so the harness can bring
# the services and the _test database up.
bun run test:integration
```
