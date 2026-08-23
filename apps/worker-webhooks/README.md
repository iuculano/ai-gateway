# worker-webhooks

Worker for draining the webhook outbox. That's pretty much it.

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/worker-webhooks dev
```

## Configuration

The application can be configure via environment variables.

| Variable                     | Default  | Description                            |
| ---------------------------- | -------- | -------------------------------------- |
| `NODE_ENV`                   | Required | `development`, `production`, or `test` |
| `POSTGRES_CONNECTION_STRING` | Required | PostgreSQL connection URL              |
| `PORT`                       | `8082`   | HTTP server port                       |
| `LOG_LEVEL`                  | `info`   | Log verbosity                          |
| `WORKER_ENABLED`             | `true`   | Set to `false` to disable processing   |
| `WORKER_POLL_INTERVAL_MS`    | `10000`  | Time between polls                     |
| `WORKER_BATCH_SIZE`          | `25`     | Maximum rows claimed per poll          |
| `WORKER_DELIVERY_TIMEOUT_MS` | `10000`  | Per-request timeout                    |
