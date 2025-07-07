import { 
  pgTable, 
  text, 
  jsonb, 
  timestamp 
} from 'drizzle-orm/pg-core';


// Holds (potentially dynamic) stateful application settings.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<Record<string, unknown>>().default({}),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
