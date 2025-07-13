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

// what the fuck
const db = drizzle(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ai_gateway');

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
