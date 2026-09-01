import { logger } from '@repo/core';
import { db, sql } from '@repo/drizzle';
import { environment } from '../environment';

const MS_PER_HOUR = 3_600_000;

/**
 * Prevents replicas from refreshing the same range at once.
 * A transaction lock releases safely when pooled connections are used.
 */
const LOCK = sql`pg_try_advisory_xact_lock(hashtext('analytics-rollup-refresh'))`;

/** Summary returned for logging. */
export interface RollupTickResult {
  status: 'written' | 'locked' | 'idle';
  chunks: number;
  rows: number;
  from?: Date;
  to?: Date;
}

/**
 * Rebuilds an hour-aligned range in one transaction.
 * Replacement removes stale groups without exposing partial results.
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
          -- Empty sums are null, but rollup totals must be zero.
          coalesce(sum(input_tokens), 0),
          coalesce(sum(output_tokens), 0),
          coalesce(sum(input_cost), 0),
          coalesce(sum(output_cost), 0),
          coalesce(sum(response_time_ms), 0),
          -- Ignore rows without latency when calculating the average.
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

/** Keeps the changing current hour in the dashboard's live tail. */
async function sealedThrough(): Promise<Date> {
  const [row] = await db.execute<{ hour: Date }>(sql`select date_trunc('hour', now()) as hour`);

  if (!row) {
    throw new Error('Failed to read the current hour');
  }

  return row.hour;
}

/**
 * Rewinds from the latest bucket so late logs are included.
 * An empty rollup starts at the first log so the same path handles backfills.
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
 * Refreshes sealed rollup hours in chunks.
 * Replacing each chunk makes retries safe after a crash.
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

    // Stop on lock contention so the next tick resumes from the true watermark.
    if (written === null) {
      return { status: 'locked', chunks, rows, from, to };
    }

    chunks += 1;
    rows += written;

    // Keep normal ticks quiet while reporting long backfills.
    if (chunks % 10 === 0) {
      logger.info({ through: next.toISOString(), chunks, rows }, 'Analytics rollup backfill progressing');
    }

    cursor = next;
  }

  return { status: 'written', chunks, rows, from, to };
}
