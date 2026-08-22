# AI Gateway

Simple AI Gateway for trying various ideas.

Pass requests through it, get automatic logging, cost tracking, and more.

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

# Create the schema
bun run db:push

# Run
bun run dev
```

Each worker reads its own `apps/<worker>/.env`.

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

From either the host or the repository dev container, a clean checkout only needs its packages installed.

```bash
bun install
bun run test:integration
```
