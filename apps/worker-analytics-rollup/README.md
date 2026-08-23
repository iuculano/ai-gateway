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

The application can be configure via environment variables.

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
