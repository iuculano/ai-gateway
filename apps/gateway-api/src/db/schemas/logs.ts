import { pgTable, uuid, text, integer, jsonb, timestamp, numeric } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


// Inference logs.
export const logs = pgTable('logs', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  prompt_tokens: integer('prompt_tokens'),
  completion_tokens: integer('completion_tokens'),
  estimated_cost: numeric('estimated_cost', { precision: 10, scale: 4 }).$type<number>().notNull().default(0),
  response_time_ms: integer('response_time_ms'),
  object_reference: text('object_reference'),
  tags: jsonb('tags').$type<Record<string, unknown>>(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
