# worker-model-catalog

Keeps the model catalogue in step with [models.dev](https://models.dev).

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/worker-model-catalog dev
```

## Configuration

The application can be configure via environment variables.

| Variable                     | Default                           | Description                            |
| ---------------------------- | --------------------------------- | -------------------------------------- |
| `NODE_ENV`                   | `development`                     | `development`, `production`, or `test` |
| `POSTGRES_CONNECTION_STRING` | Required                          | PostgreSQL connection URL              |
| `PORT`                       | `8083`                            | HTTP server port                       |
| `LOG_LEVEL`                  | `info`                            | Log verbosity                          |
| `WORKER_ENABLED`             | `true`                            | Set to `false` to disable processing   |
| `WORKER_POLL_INTERVAL_MS`    | `3600000`                         | Time between polls                     |
| `CATALOG_SOURCE_URL`         | `https://models.dev/catalog.json` | Catalogue source URL                   |
| `CATALOG_FETCH_TIMEOUT_MS`   | `30000`                           | Catalogue request timeout              |
