import { type ClickHouseClient, createClient } from '@clickhouse/client';

export { ClickHouseError } from '@clickhouse/client';
export type ClickHouse = ClickHouseClient;


export interface ClickHouseOptions {
  url: string;
  user?: string;
  password?: string;
  database?: string;
}

export function createClickHouse(options: ClickHouseOptions): ClickHouse {
  return createClient({
    url: options.url,
    username: options.user ?? 'default',
    password: options.password ?? '',
    database: options.database,
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  });
}
