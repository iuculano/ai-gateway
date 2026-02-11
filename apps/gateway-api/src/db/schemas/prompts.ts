import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


export const prompts = pgTable('prompts', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  name: text('name').notNull().unique(),
  description: text('description'),
  activeVersion: integer('active_version').notNull(),
  tags: jsonb('tags').$type<Record<string, string>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const promptVersions = pgTable('prompt_versions', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),

  promptId: uuid('prompt_id')
    .notNull()
    .references(() => prompts.id, { onDelete: 'cascade' }),

  prompt: text('prompt').notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
