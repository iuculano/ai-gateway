import { drizzle } from 'drizzle-orm/bun-sql';
import { environment } from '@lib/environment';

const db = drizzle(
  `postgres://${environment.POSTGRES_USERNAME}:${environment.POSTGRES_PASSWORD}@${environment.POSTGRES_ENDPOINT}/${environment.POSTGRES_DATABASE}`
);

export { db };
export {
  sql,
  gte,
  gt,
  lte,
  lt,
  eq,
  not,
  and,
  or,
  asc,
  desc,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
