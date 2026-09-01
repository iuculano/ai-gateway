# Gateway stress tests

The stress tier is manual and destructive by design: it creates inference logs,
payload objects, Redis usage counters, and database load. Run it against local
or otherwise disposable infrastructure, never a production tenant.

Project commands must run in the repository dev container. Start PostgreSQL,
Valkey, MinIO, and the gateway before running the HTTP harness:

```sh
docker compose up -d postgres valkey minio minio-init
bun run --cwd packages/drizzle db:push
bun run --cwd apps/gateway-backend dev
```

## Dataset-scale log reads

`stress:logs` bulk-seeds realistic rows in PostgreSQL and measures service-layer
queries. Runs are additive so several invocations can build a scaling curve.

```sh
bun run stress:logs -- --count 20000 --out .stress/logs.jsonl
bun run stress:logs -- --count 80000 --out .stress/logs.jsonl
bun run stress:logs -- --count 400000 --out .stress/logs.jsonl
```

Scenario groups are independently selectable:

```sh
# Common, rare, absent, unique/high-cardinality, multi-tag, and combined filters.
bun run stress:logs -- \
  --skip-seed \
  --groups tags \
  --concurrency 8 \
  --iterations 30 \
  --explain \
  --require-indexes

# Exercise the exact-to-sampled stats transition around 100,000 rows.
bun run stress:logs -- --skip-seed --groups stats --max-p95-ms 100 --fail-on-thresholds

# Select one scenario by a case-insensitive substring.
bun run stress:logs -- --skip-seed --groups analytics --match "rare"
```

Use `--help` for every option. `--reset` deletes only rows carrying the stress
seed marker. `--require-indexes` is intentionally size-sensitive; use it at
100,000 rows or more, where PostgreSQL should prefer the model and GIN tag
indexes over a legitimate small-table sequential scan.

## End-to-end HTTP and RPS

`stress:gateway` uses a constant-arrival-rate scheduler. Slow responses do not
reduce the offered rate; once `--concurrency` is full, arrivals are reported as
dropped. Unless `--upstream-url` is supplied, it starts a deterministic local
OpenAI-compatible provider so the result measures the gateway rather than a
paid external model.

When `--api-key`/`STRESS_API_KEY` is omitted, the harness uses
`POSTGRES_ADMIN_CONNECTION_STRING` to create a temporary key in the selected
organization and removes the key after the run. The key grants only chat and
log scopes.

```sh
# Compare raw routing/auth, row-only logging, and full PostgreSQL + MinIO logging.
bun run stress:gateway -- \
  --rates 25,50,100,200 \
  --duration-seconds 30 \
  --logging-modes skip,row,full \
  --out .stress/gateway.jsonl \
  --metrics-out .stress/metrics.prom

# Streaming concurrency and time-to-first-byte.
bun run stress:gateway -- \
  --rates 25,50 \
  --protocols stream \
  --provider-delay-ms 100 \
  --provider-chunks 8 \
  --provider-chunk-delay-ms 25

# Mixed inference writes, dashboard reads, stats, and payload batch reads.
bun run stress:gateway -- \
  --logging-modes full \
  --mix chat:80,logs:10,stats:5,payloads:5 \
  --batch-size 100 \
  --rates 50,100
```

The mock provider's delay, chunk count, chunk delay, response size, failure
rate, and failure status are configurable. Request size, workload mix, log
query string, rate stages, concurrency, timeouts, warmup, and duration are also
configurable. For an external provider mock, set `--upstream-url`, `--model`,
and `--provider-api-key` (or `STRESS_PROVIDER_API_KEY`).

### Rate-limit contention

The optional quota burst sends concurrent requests through the HTTP handler and
checks the exact number of 200 and 429 responses:

```sh
bun run stress:gateway -- \
  --rates 10 \
  --duration-seconds 2 \
  --logging-modes skip \
  --quota 100 \
  --quota-attempts 300 \
  --quota-concurrency 300 \
  --fail-on-thresholds
```

A temporary key has isolated limiter state and is reset automatically. Testing
an existing key requires `--reset-rate-limit` because doing so deletes that
key's current chat-completion limiter window.

### Thresholds and cleanup

`--max-error-rate`, `--max-p95-ms`, and `--min-rate-ratio` define acceptance
criteria. Add `--fail-on-thresholds` for a non-zero exit code suitable for a
controlled CI runner. Invariant failures—missing log IDs, malformed responses,
incomplete streams, or missing full payloads—are reported alongside performance
thresholds.

By default, generated logs remain available for inspection and future
dataset-scale runs. `--cleanup` deletes every captured log through the gateway,
including its request and response objects.

Use the same fixed container resources and database state when comparing runs.
Absolute RPS from different laptops or unconstrained CI runners is not a useful
regression signal.
