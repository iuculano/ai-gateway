# @repo/redis

Shared Redis client and rate-limiter implementations for the AI gateway.

## Integration tests

The limiter tests execute their Lua scripts against a real Redis-compatible
server. They require a dedicated logical database above database 0 and erase
that database before and after the suite.

From the repository dev container:

```bash
cd packages/redis
REDIS_PACKAGE_TEST_URL=redis://host.docker.internal:6379/14 bun run test:integration
```

Database 14 is intentionally different from the backend integration suite's
documented database 15, allowing both suites to run concurrently.

To run every workspace integration suite, provide both test URLs:

```bash
REDIS_PACKAGE_TEST_URL=redis://host.docker.internal:6379/14 \
REDIS_TEST_URL=redis://host.docker.internal:6379/15 \
bun run test:integration
```
