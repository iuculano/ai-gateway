import { pgTable, uuid, text, integer, jsonb, timestamp, numeric } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


// Inference logs.
export const logs = pgTable('logs', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  estimated_cost: numeric('estimated_cost', { precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  response_time_ms: integer('response_time_ms'),
  object_reference: text('object_reference'),
  tags: jsonb('tags').$type<Record<string, unknown>>(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
