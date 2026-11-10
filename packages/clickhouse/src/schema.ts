import type { ClickHouse } from './client';

const LOGS = `
  CREATE TABLE IF NOT EXISTS logs (
    id               UUID,
    organization_id  UUID,
    created_at       DateTime64(3, 'UTC'),
    updated_at       DateTime64(6, 'UTC'),
    operation        LowCardinality(String),
    model            LowCardinality(String),
    provider         LowCardinality(String),
    status           LowCardinality(String),
    actor_id         UUID,
    input_tokens     UInt32,
    output_tokens    UInt32,
    input_cost       Decimal(20, 12),
    output_cost      Decimal(20, 12),
    response_time_ms Nullable(UInt32),
    gateway_cache_hit Bool, -- answered from the gateway's response cache
    cached_input_tokens UInt32, -- input tokens the provider served from its prompt cache
    tags             Map(LowCardinality(String), String),

    -- Well-known tags, copied out of the map on insert so analytics can group
    -- and filter on them like any other column. '' when a log isn't tagged.
    user_id          String MATERIALIZED tags['user_id'],
    session_id       String MATERIALIZED tags['session_id']
  )
  ENGINE = ReplacingMergeTree(updated_at)
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (organization_id, created_at, id)
  SETTINGS storage_policy = 'object_store', default_compression_codec = 'ZSTD(3)'
`;

// Not sure I really like this, but...
const ADDED_COLUMNS = [
  'gateway_cache_hit Bool AFTER response_time_ms',
  'cached_input_tokens UInt32 AFTER gateway_cache_hit',
];

// The last log the sync fully copied. Written only after a whole batch lands,
// so a failed insert gets retried instead of skipped.
const SYNC_CURSOR = `
  CREATE TABLE IF NOT EXISTS sync_cursor (
    updated_at DateTime64(6, 'UTC'),
    id         UUID
  )
  ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY tuple()
`;

/**
 * Creates schemas if they don't exist. Safe to run on every start.
 *
 * @param clickhouse
 * The ClickHouse client to use for executing the schema creation commands.
 */
export async function ensureSchema(clickhouse: ClickHouse): Promise<void> {
  await clickhouse.command({ query: LOGS });

  for (const column of ADDED_COLUMNS) {
    await clickhouse.command({ query: `ALTER TABLE logs ADD COLUMN IF NOT EXISTS ${column}` });
  }

  await clickhouse.command({ query: SYNC_CURSOR });
}
