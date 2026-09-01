# @repo/auth

Who the caller is, and what they're allowed to do.

Two adapters answer the first question. `jwt-adapter-zitadel` verifies a bearer
token from the identity provider and resolves it to a local user;
`key-adapter-generic` looks up an `aik_` API key. Both hand back the same
caller shape, so routes never learn which one ran.

The rest is the mapping layer: identity-provider claims to organizations,
project roles to scopes.

## Tests

Hermetic. `@repo/drizzle` and the limiter are swapped for doubles from
`@repo/test-helpers` before the modules under test are imported, so no
database, Redis, or identity provider is involved.

```bash
bun run --cwd packages/auth test:unit
bun run --cwd packages/auth test:unit:coverage
```
