import type { ClickHouse } from './client';

const LOGS = `
  CREATE TABLE IF NOT EXISTS logs (
    id                  UUID,
    organization_id     UUID,
    created_at          DateTime64(3, 'UTC'),
    updated_at          DateTime64(6, 'UTC'),
    operation           LowCardinality(String),
    model               LowCardinality(String),
    provider            LowCardinality(String),
    status              LowCardinality(String),
    actor_id            UUID,
    input_tokens        UInt32,
    output_tokens       UInt32,
    input_cost          Decimal(20, 12),
    output_cost         Decimal(20, 12),
    response_time_ms    Nullable(UInt32),
    gateway_cache_hit   Bool,
    cached_input_tokens UInt32,
    tags                Map(LowCardinality(String), String),

    -- Well-known tags.
    user_id          String MATERIALIZED tags['user_id'],
    session_id       String MATERIALIZED tags['session_id'],

    -- Finds a session's rows without reading the whole window.
    INDEX session_id_bloom session_id TYPE bloom_filter(0.01) GRANULARITY 1
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

// The last log the sync fully copied.
const SYNC_CURSOR = `
  CREATE TABLE IF NOT EXISTS sync_cursor (
    updated_at DateTime64(6, 'UTC'),
    id         UUID
  )
  ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY tuple()
`;

/**
 * Create ann index, if it doesn't already exist.
 *
 * @param clickhouse
 * The ClickHouse client to use.
 *
 * @param name
 * The index's name, as in the logs table definition.
 *
 * @param definition
 * What follows the name in the logs table definition.
 */
async function createIndex(clickhouse: ClickHouse, name: string, definition: string): Promise<void> {
  const existing = await clickhouse.query({
    query: `
      SELECT 1 FROM system.data_skipping_indices
      WHERE database = currentDatabase() AND table = 'logs' AND name = {name:String}
    `,
    query_params: { name: name },
    format: 'JSONEachRow',
  });

  // Bail if the index already exists.
  if ((await existing.json()).length > 0) {
    return;
  }

  await clickhouse.command({ query: `ALTER TABLE logs ADD INDEX ${name} ${definition}` });
  await clickhouse.command({ query: `ALTER TABLE logs MATERIALIZE INDEX ${name}` });
}

/**
 * Creates schemas if they don't exist. Runs on startup.
 *
 * @param clickhouse
 * The ClickHouse client to use for executing the schema creation commands.
 */
export async function ensureSchema(clickhouse: ClickHouse): Promise<void> {
  await clickhouse.command({ query: LOGS });

  for (const column of ADDED_COLUMNS) {
    await clickhouse.command({ query: `ALTER TABLE logs ADD COLUMN IF NOT EXISTS ${column}` });
  }

  await createIndex(clickhouse, 'session_id_bloom', 'session_id TYPE bloom_filter(0.01) GRANULARITY 1');

  await clickhouse.command({ query: SYNC_CURSOR });
}
