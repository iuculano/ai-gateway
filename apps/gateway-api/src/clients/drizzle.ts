import { drizzle } from 'drizzle-orm/postgres-js';
import {
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
import { environment } from '../utils/environment';

// This file formatting is ridiculous
const db = drizzle(environment.POSTGRES_URL);

export {
  db,
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
};
