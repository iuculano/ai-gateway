import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * Model data such as cost, configuration, etc.
 */
export const models = pgTable('models', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull(), // e.g., 'gpt-4-turbo'
  provider: text().notNull(),
  cost_input: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  cost_output: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  config: jsonb().$type<Record<string, unknown>>().default({}),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
