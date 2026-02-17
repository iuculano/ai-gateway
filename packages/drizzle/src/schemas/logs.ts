import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';

/**
 * Table for logging inference requests and responses.
 *
 * Note that the request and response themselves are not stored here. It is
 * stored in an object storage solution and the URL is stored in the
 * `object_reference` column.
 *
 * This is to avoid bloating the database.
 */
export const logs = pgTable('logs', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
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
