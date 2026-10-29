import { clickhouse } from '@repo/clickhouse';
import { db, sql } from '@repo/drizzle';
import type { LogRow } from '@repo/drizzle/schemas';
import { environment } from '../environment';

// Rows are only copied once they're this old.
const SETTLE_SECONDS = 30;

// Row that will be inserted into ClickHouse.
type SyncedLog = Pick<
  LogRow,
  | 'id'
  | 'organization_id'
  | 'operation'
  | 'model'
  | 'provider'
  | 'status'
  | 'actor_type'
  | 'actor_id'
  | 'input_tokens'
  | 'output_tokens'
  | 'response_time_ms'
> & {
  created_at: string;
  updated_at: string;
  input_cost: string; // let clickhouse parse the numeric text
  output_cost: string;
};

/**
 * Copies settled log rows from Postgres to ClickHouse.
 */
export async function tickAnalyticsSync() {
  // Grab the newest row ClickHouse has, so we have a starting point for sync.
  const query = `
    SELECT
      toString(updated_at) AS at,
      toString(id)         AS id
    FROM logs
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;

  const [cursor] = await (
    await clickhouse.query({
      query,
      format: 'JSONEachRow',
    })
  ).json<{ at: string; id: string }>();

  //
  let rows = 0;
  let batches = 0;

  while (cursor) {
    // Grab batch of rowws from Postgres that have settled and are newer than
    // the last synced row.
    const batch = await db.execute<SyncedLog>(sql`
      select
        id,
        organization_id,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as created_at,
        to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as updated_at,
        operation,
        model,
        provider,
        status,
        actor_type,
        actor_id,
        input_tokens,
        output_tokens,
        input_cost,
        output_cost,
        response_time_ms
      from logs

      -- Only select rows that have settled and are newer than the last synced row.
      where (updated_at, id) > (${cursor.at}::timestamp at time zone 'UTC', ${cursor.id}::uuid)
        and updated_at < now() - make_interval(secs => ${SETTLE_SECONDS})

      order by logs.updated_at, logs.id
      limit ${environment.SYNC_BATCH_ROWS}
    `);

    // Empty batch, nothing left to do.
    const last = batch.at(-1);
    if (!last) {
      break;
    }

    // Insert batch into ClickHouse and update cursor.
    await clickhouse.insert({ table: 'logs', values: batch, format: 'JSONEachRow' });
    rows += batch.length;
    batches += 1;
    cursor.at = last.updated_at;
    cursor.id = last.id;

    if (batch.length < environment.SYNC_BATCH_ROWS) {
      break;
    }
  }

  return { rows, batches };
}
