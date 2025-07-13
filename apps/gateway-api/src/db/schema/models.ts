import { pgTable, uuid, text, numeric, jsonb, timestamp, check } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';


  // Originally, this was used because a provider exclusively held the base url...
  // But that's currently really all it was used for.
  //
  // We can get rid of an entire table and API route by just allowing you to
  // specify that in the request headers...
  //
  // provider_id: uuid('provider_id')
  //   .notNull()
  //   .references(() => providers.id, { onDelete: 'restrict' }), // FK to providers.id

// Representation of an LLM that is available to inference.
// Provider must be set to a supported provider.
export const models = pgTable('models', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  name: text('name').notNull(), // e.g., 'gpt-4-turbo'
  provider: text('provider').notNull(),
  cost_input: numeric('cost_input', { precision: 10, scale: 4 }).$type<number>().notNull().default(0),
  cost_output: numeric('cost_output', { precision: 10, scale: 4 }).$type<number>().notNull().default(0),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  tags: jsonb('tags').$type<Record<string, unknown>>().default({}),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  check("provider_check", sql`${table.provider} IN ('openai', 'anthropic', 'azure', 'local')`),
]);
