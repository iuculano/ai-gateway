import { logger } from '@repo/core';
import { db, sql } from '@repo/drizzle';
import { environment } from '../environment';

const MS_PER_HOUR = 3_600_000;

/**
 * Serialises refreshes across replicas.
 *
 * The transaction-scoped form, not `pg_try_advisory_lock`. A session lock is
 * bound to the connection that took it, and every statement here goes through a
 * pool - so the release could land on a different connection than the acquire
 * and leak the lock for the life of the process. `_xact_` releases at COMMIT or
 * ROLLBACK, on the right connection, including when the process is killed.
 */
const LOCK = sql`pg_try_advisory_xact_lock(hashtext('analytics-rollup-refresh'))`;

/** What one tick did, for the caller to log. */
export interface RollupTickResult {
  status: 'written' | 'locked' | 'idle';
  chunks: number;
  rows: number;
  from?: Date;
  to?: Date;
}

/**
 * Recomputes one hour-aligned range from `logs` and replaces it wholesale.
 *
 * DELETE then INSERT, not an upsert, and the difference is correctness rather
 * than taste. An upsert only touches the groups the new aggregate produced, so
 * a group that STOPPED existing keeps its stale row: ten requests logged
 * 'incomplete' and later updated to 'complete' would leave the incomplete row
 * behind at ten, and the hour would report twenty requests. Replacing the range
 * cannot drift, because the range's contents are only ever whatever `logs` says
 * right now.
 *
 * Both statements run in one transaction, so a reader never observes the gap
 * between the delete and the insert, and an interrupted run leaves the range
 * exactly as it was.
 *
 * @param from
 * Start of the range, inclusive. Truncated to the hour here rather than
 * trusted: a misaligned bound would delete one set of buckets and insert a
 * different one, and the leftovers would collide with the unique key.
 *
 * @param to
 * End of the range, exclusive.
 *
 * @returns
 * The number of rollup rows written, or null when another replica holds the
 * lock and this tick did nothing.
 */
async function refreshRange(from: Date, to: Date): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ acquired: boolean }>(sql`select ${LOCK} as acquired`);

    if (!lock?.acquired) {
      return null;
    }

    await tx.execute(sql`
      delete from analytics_hourly
       where bucket >= date_trunc('hour', ${from}::timestamptz)
         and bucket <  date_trunc('hour', ${to}::timestamptz)
    `);

    const [written] = await tx.execute<{ rows: number }>(sql`
      with inserted as (
        insert into analytics_hourly (
          organization_id, bucket, model, provider, status, actor_type, actor_id,
          requests, input_tokens, output_tokens, input_cost, output_cost,
          latency_sum, latency_count, latency_min, latency_max, refreshed_at
        )
        select
          organization_id,
          date_trunc('hour', created_at),
          model,
          provider,
          status,
          actor_type,
          actor_id,
          count(*),
          -- COALESCE because sum() over an all-null set is null, and these
          -- columns are NOT NULL. An 'incomplete' row has no tokens at all.
          coalesce(sum(input_tokens), 0),
          coalesce(sum(output_tokens), 0),
          coalesce(sum(input_cost), 0),
          coalesce(sum(output_cost), 0),
          coalesce(sum(response_time_ms), 0),
          -- count(column), not count(*): rows that never recorded a latency
          -- must not inflate the denominator of the average.
          count(response_time_ms),
          min(response_time_ms),
          max(response_time_ms),
          now()
        from logs
        where created_at >= date_trunc('hour', ${from}::timestamptz)
          and created_at <  date_trunc('hour', ${to}::timestamptz)
        group by 1, 2, 3, 4, 5, 6, 7
        returning 1
      )
      select count(*)::int as rows from inserted
    `);

    return written?.rows ?? 0;
  });
}

/**
 * The exclusive upper bound of every refresh: the start of the current hour.
 *
 * The hour in progress is deliberately never stored. Requests are still landing
 * in it, so any row written for it is wrong the moment after it is written -
 * and a partial bucket sitting in the rollup would be double counted by a
 * dashboard that reads sealed hours from here and the live tail from `logs`.
 */
async function sealedThrough(): Promise<Date> {
  const [row] = await db.execute<{ hour: Date }>(sql`select date_trunc('hour', now()) as hour`);

  if (!row) {
    throw new Error('Failed to read the current hour');
  }

  return row.hour;
}

/**
 * Where this tick starts recomputing.
 *
 * The watermark is `max(bucket)` read from the rollup itself rather than from a
 * separate state table, so it cannot disagree with the data it describes: if a
 * transaction rolled back, the bucket is not there and the watermark moves back
 * with it automatically.
 *
 * Backfill is not a separate code path. On an empty rollup this returns the
 * first logged hour, and the chunking in tickAnalyticsRollup() walks the whole
 * history with the same statement the incremental case uses - one
 * implementation, so the backfill cannot drift from the refresh.
 *
 * @returns
 * The inclusive start, or null when there is nothing logged at all.
 */
async function refreshFrom(): Promise<Date | null> {
  const [row] = await db.execute<{ start: Date | null }>(sql`
    select coalesce(
      (select max(bucket) - make_interval(hours => ${environment.ROLLUP_TRAILING_WINDOW_HOURS})
        from analytics_hourly),
      (select date_trunc('hour', min(created_at)) from logs)
    ) as start
  `);

  return row?.start ?? null;
}

/**
 * One pass of the rollup refresh.
 *
 * Idempotent by construction: running it twice over the same range produces the
 * same rows, so a crashed run needs no recovery beyond being run again.
 */
export async function tickAnalyticsRollup(): Promise<RollupTickResult> {
  const to = await sealedThrough();
  const from = await refreshFrom();

  if (!from || from >= to) {
    return { status: 'idle', chunks: 0, rows: 0 };
  }

  const chunkMs = environment.ROLLUP_CHUNK_HOURS * MS_PER_HOUR;

  let cursor = from;
  let chunks = 0;
  let rows = 0;

  while (cursor < to) {
    const next = new Date(Math.min(cursor.getTime() + chunkMs, to.getTime()));
    const written = await refreshRange(cursor, next);

    // Another replica is mid-refresh. Stopping rather than skipping ahead keeps
    // the watermark meaningful: the next tick re-reads it and resumes from
    // wherever that replica actually got to.
    if (written === null) {
      return { status: 'locked', chunks, rows, from, to };
    }

    chunks += 1;
    rows += written;

    // Only worth saying during a backfill, which is the only time this loop
    // runs more than once.
    if (chunks % 10 === 0) {
      logger.info({ through: next.toISOString(), chunks, rows }, 'Analytics rollup backfill progressing');
    }

    cursor = next;
  }

  return { status: 'written', chunks, rows, from, to };
}
