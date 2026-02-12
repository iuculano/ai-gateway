import { pgTable, uuid, text, integer, jsonb, timestamp, numeric } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


// Inference logs.
export const logs = pgTable('logs', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  model: text().notNull(),
  provider: text().notNull(),
  status: text().notNull(),
  input_tokens: integer(),
  output_tokens: integer(),
  input_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  output_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  response_time_ms: integer(),
  object_reference: text(),
  tags: jsonb().$type<Record<string, string>>(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
