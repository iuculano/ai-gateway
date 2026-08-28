# @repo/redis

The shared Redis client, plus some rate limiters taken from the Redis blog.

## Tests

There are no unit tests. The scripts are exercised against a real Redis server.

```bash
REDIS_PACKAGE_TEST_URL=redis://host.docker.internal:6379/14 \
  bun run --cwd packages/redis test:integration
```
