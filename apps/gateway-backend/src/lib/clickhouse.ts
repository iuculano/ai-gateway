import { createClickHouse } from '@repo/clickhouse';
import { environment } from '../environment';

export const clickhouse = createClickHouse({
  url: environment.CLICKHOUSE_URL,
  user: environment.CLICKHOUSE_USER,
  password: environment.CLICKHOUSE_PASSWORD,
  database: environment.CLICKHOUSE_DATABASE,
});
