# @repo/hono

Shared Hono middleware, OpenAPI response definitions, and request-scoped
caller utilities for the AI gateway.

## Tests

The suite runs entirely in process. Authentication adapters, Bun connection
metadata, request loggers, and Hono applications are supplied as local test
fixtures, so no identity provider, Redis instance, or HTTP server is required.

```bash
cd packages/hono
bun run test:unit
bun run test:unit:coverage
```
