import { 
  pgTable, 
  text, 
  jsonb, 
  timestamp 
} from 'drizzle-orm/pg-core';


// Holds (potentially dynamic) stateful application settings.
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull().$type<Record<string, unknown>>().default({}),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
});
