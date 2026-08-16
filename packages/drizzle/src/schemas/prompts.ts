import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Templatable prompts that can be versioned and used in inference requests.
 */
export const prompts = pgTable('prompts', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull().unique(),
  description: text(),
  active_version: integer(),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Versioned prompt configurations.
 *
 * This is where the actual prompt data is stored.
 */
export const promptVersions = pgTable('prompt_versions', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  prompt_id: uuid()
    .notNull()
    .references(() => prompts.id, { onDelete: 'cascade' }),
  prompt: text().notNull(),
  version: integer().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
