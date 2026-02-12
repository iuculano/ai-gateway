import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


export const prompts = pgTable('prompts', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  name: text().notNull().unique(),
  description: text(),
  active_version: integer(),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const promptVersions = pgTable('prompt_versions', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),

  prompt_id: uuid()
    .notNull()
    .references(() => prompts.id, { onDelete: 'cascade' }),

  prompt: text().notNull(),
  version: integer().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
