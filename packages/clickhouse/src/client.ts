import { createClient } from '@clickhouse/client';

export { ClickHouseError } from '@clickhouse/client';

function createClickHouseClient() {
  return createClient({
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'ai_gateway',
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  });
}

export type ClickHouse = ReturnType<typeof createClickHouseClient>;

/**
 * The shared client. Built at import, so the CLICKHOUSE_* settings must already
 * be set by then - Bun loads .env first, and integration tests preload theirs.
 */
export const clickhouse = createClickHouseClient();
