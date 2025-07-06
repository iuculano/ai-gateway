import { pgTable, uuid, text, numeric, boolean, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


export const logs = pgTable('logs', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),

  model: text('model').notNull(),
  provider: text('provider').notNull(),

  status: text('status').notNull(),

  prompt_tokens: integer('prompt_tokens'),
  completion_tokens: integer('completion_tokens'),
  response_time_ms: integer('response_time_ms'),

  cost: numeric('cost', { precision: 10, scale: 4 }).notNull().default('0'),

  tags: jsonb('tags').$type<Record<string, any>>(),

  created_at: timestamp('created_at', { withTimezone: false, mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: false, mode: 'string' }).notNull().defaultNow(),
});
