import { type SQL, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleClient } from './client';

export interface CountRowsOptions {
  where?: SQL;
  threshold?: number;
}

export interface RowCount {
  count: number;
  estimated: boolean;
}

/**
 * Helper for counting rows fast.
 *
 * When beyond the specified threshold, an estimated count is returned using the
 * query planner instead.
 *
 * @param client
 * The Drizzle client to use for executing queries.
 *
 * @param table
 * The table to count rows in.
 *
 * @param options
 * Options for counting rows.
 *
 * @returns
 * The row count and whether it is estimated.
 */
export async function countRows(
  client: DrizzleClient,
  table: PgTable,
  options: CountRowsOptions = {},
): Promise<RowCount> {
  const { where, threshold = 100_000 } = options;

  // Additional predicate - for example, if you need to do a tenant check.
  const predicate = where ? sql`where ${where}` : sql``;

  // Just count and see if we're within threshold first.
  const [row] = await client.execute<{ count: string | number }>(sql`
    select count(*) as count from (
      select 1 from ${table} ${predicate} limit ${threshold + 1}
    ) bounded_count
  `);

  // biome-ignore lint/style/noNonNullAssertion: COUNT always returns one row.
  const count = Number(row!.count);
  if (count <= threshold) {
    return { count, estimated: false };
  }

  // https://www.citusdata.com/blog/2016/10/12/count-performance/#dup_counts_estimated
  const [rowPlan] = await client.execute<{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': number } }] }>(
    sql`explain (format json) select 1 from ${table} ${predicate}`,
  );

  // biome-ignore lint/style/noNonNullAssertion: EXPLAIN always returns a query plan.
  const estimate = rowPlan!['QUERY PLAN'][0].Plan['Plan Rows'];

  return {
    count: Math.max(count, estimate), // don't return lower than what we already counted
    estimated: true
  };
}
