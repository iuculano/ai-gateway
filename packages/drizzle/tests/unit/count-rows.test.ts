import { expect, test } from 'bun:test';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';
import type { DrizzleClient } from '../../src/util/client';
import { countRows } from '../../src/util/count-rows';

const records = pgTable('records', { organizationId: text('organization_id') });
const dialect = new PgDialect();

function database(responses: unknown[]) {
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const client = {
    execute: async (query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      if (!responses.length) throw new Error('Unexpected query');
      return responses.shift();
    },
  } as unknown as DrizzleClient;
  return { client, queries };
}

for (const count of [0, 9, 10]) {
  test(`returns an exact count of ${count} without EXPLAIN`, async () => {
    const db = database([[{ count: String(count) }]]);
    expect(await countRows(db.client, records, { threshold: 10 })).toEqual({ count, estimated: false });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.params).toEqual([11]);
  });
}

test('uses the same tenant filter for bounded count and estimate', async () => {
  const plan = [{ Plan: { 'Plan Rows': 2500 } }];
  const db = database([[{ count: 11 }], [{ 'QUERY PLAN': plan }]]);
  expect(await countRows(db.client, records, { threshold: 10, where: eq(records.organizationId, 'tenant-a') })).toEqual(
    { count: 2500, estimated: true },
  );
  expect(db.queries[0]?.params).toEqual(['tenant-a', 11]);
  expect(db.queries[1]?.params).toEqual(['tenant-a']);
  expect(db.queries[1]?.sql).toContain('explain (format json)');
  expect(db.queries[1]?.sql).not.toContain('analyze');
});

test('does not undercut the proven minimum when planner statistics are stale', async () => {
  const db = database([[{ count: 11 }], [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 0 } }] }]]);
  expect(await countRows(db.client, records, { threshold: 10 })).toEqual({ count: 11, estimated: true });
});

test('database failures propagate rather than becoming zero counts', async () => {
  const db = database([]);
  await expect(countRows(db.client, records)).rejects.toThrow('Unexpected query');
});
