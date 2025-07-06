import { 
  pgTable, 
  text, 
  jsonb, 
  timestamp 
} from 'drizzle-orm/pg-core';

/**
 * Holds (potentially dynamic) application settings.
 *
 * - `key`:       The unique identifier for the setting (primary key).
 * - `value`:     The value of the setting, stored as a JSONB object. This field is required.
 * - `updatedAt`: The timestamp indicating when the setting was last updated. Defaults to the current time.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<Record<string, any>>().default({}),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
