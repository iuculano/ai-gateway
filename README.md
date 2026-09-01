# AI Gateway

Simple AI Gateway for trying various ideas.

Pass requests through it, get automatic logging, cost tracking, and more.

![Screenshot](docs/images/analytics.webp)

## Getting started

You probably want Docker installed at minimum. From there, you can leverage the
included Dev Container manifest.

```bash
# Install packages
bun install

# Start the backing services
docker compose up --detach --wait postgres valkey minio

# Drop the little helper that creates some buckets in MinIO
docker compose run --rm minio-init

# Create the schema. drizzle-kit wants an admin connection and has no default.
POSTGRES_ADMIN_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/ai_gateway \
  bun run db:push

# Run
bun run dev
```

Each app reads its own `apps/<app>/.env`.

| App                      | Port |
| ------------------------ | ---- |
| gateway-backend          | 8080 |
| gateway-frontend         | 8081 |
| worker-webhooks          | 8082 |
| worker-model-catalog     | 8083 |
| worker-analytics-rollup  | 8084 |

From inside the devcontainer, replace `localhost` with `host.docker.internal`
in every service URL - the containers run on the host, not alongside you.

## Running tests

Unit tests don't need anything special to run.

```bash
bun run test:unit
```

From either the host or the repository dev container, a clean checkout only
needs its packages installed. The harness starts the compose services and
prepares the separate `_test` database itself.

```bash
bun install
bun run test:integration
```

Browser tests want Chromium, which is a one-time install.

```bash
bunx playwright install --with-deps chromium
bun run test:e2e
```
