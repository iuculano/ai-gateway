# @repo/test-helpers

The two fixtures more than one unit tier needs.

`DatabaseDouble` stands in for Drizzle's fluent query builder. Tests arrange
responses by operation and table, while the fake records each complete fluent
query and its transaction membership. It lives here because gateway-backend
and `@repo/auth` had grown byte-identical copies of the older positional fake.

```ts
const { database, db } = createDatabaseDouble();

database.respondTo('select', 'models', rows(model));
database.respondTo('insert', 'audit_logs', rows(auditLog));

await serviceUsing(db);

expect(database.queriesFor('insert', 'audit_logs')).toHaveLength(1);
database.assertResponsesConsumed();
```

Responses queue only within one operation/table route. `defaultResponse` adds
a reusable fallback for incidental boundary work; every `respondTo` response
is one-shot and should be checked by `assertResponsesConsumed` in `afterEach`.

`ids` holds the organization, user, and key ids those suites share, fixed
rather than generated so a failure names the same tenant everywhere.

Nothing here imports `@repo/drizzle`, or anything else - the double needs the
builder's shape, not its types, and staying dependency-free keeps this package
off every other workspace's dependency graph.

A dev dependency only. Nothing that ships imports it.
