# gateway-backend

The gateway itself.

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/gateway-backend dev
```

## Configuration

The application can be configure via environment variables.

| Variable                           | Default                  | Description                            |
| ---------------------------------- | ------------------------ | -------------------------------------- |
| `NODE_ENV`                         | `development`            | `development`, `production`, or `test` |
| `POSTGRES_CONNECTION_STRING`       | Required                 | PostgreSQL connection URL              |
| `PORT`                             | `8080`                   | HTTP server port                       |
| `LOG_LEVEL`                        | `info`                   | Log verbosity                          |
| `S3_ACCESS_KEY_ID`                 | Required                 | Object storage access key              |
| `S3_SECRET_ACCESS_KEY`             | Required                 | Object storage secret key              |
| `S3_BUCKET`                        | Required                 | Object storage bucket                  |
| `S3_ENDPOINT`                      | Optional                 | S3-compatible endpoint URL             |
| `S3_REGION`                        | `us-east-1`              | Object storage region                  |
| `REDIS_URL`                        | `redis://localhost:6379` | Redis connection URL                   |
| `REDIS_USERNAME`                   | Optional                 | Redis username                         |
| `REDIS_PASSWORD`                   | Optional                 | Redis password                         |
| `API_KEY_AUTH_CACHE_TTL_SECONDS`   | `60`                     | API key cache lifetime                 |
| `IDENTITY_PROVIDER_TOKEN_ISSUER`   | Required                 | Expected token issuer URL              |
| `IDENTITY_PROVIDER_TOKEN_AUDIENCE` | Required                 | Expected token audience                |
