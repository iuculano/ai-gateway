# gateway-frontend

Web interface for the gateway.

## Getting started

If running locally, bring up the supporting infrastructure first.

```bash
# From the repository root, if not already running.
docker compose up -d

# Then you can start the app. You may need to create a .env file first.
bun run --cwd apps/gateway-frontend dev
```

## Configuration

The application can be configure via environment variables.

| Variable                   | Default                 | Description                    |
| -------------------------- | ----------------------- | ------------------------------ |
| `PORT`                     | `8081`                  | HTTP server port               |
| `BACKEND_URL`              | `http://localhost:8080` | Gateway backend URL            |
| `ZITADEL_ISSUER`           | Required                | OIDC issuer URL                |
| `ZITADEL_CLIENT_ID`        | Required                | OIDC client ID                 |
| `OIDC_REFRESH_ENABLED`     | `false`                 | Request refresh tokens         |
| `POST_LOGOUT_REDIRECT_URI` | Optional                | Redirect after identity logout |
| `REDIS_URL`                | `redis://localhost:6379` | Redis connection URL           |
| `REDIS_USERNAME`           | Optional                | Redis username                 |
| `REDIS_PASSWORD`           | Optional                | Redis password                 |
| `SESSION_IDLE_SECONDS`     | `28800`                 | Session idle lifetime          |
| `SESSION_ABSOLUTE_SECONDS` | `604800`                | Maximum session lifetime       |
