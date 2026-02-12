import { pgTable, uuid, text, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


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
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  name: text().notNull(), // e.g., 'gpt-4-turbo'
  provider: text().notNull(),
  cost_input: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  cost_output: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
  config: jsonb().$type<Record<string, unknown>>().default({}),
  tags: jsonb().$type<Record<string, unknown>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
