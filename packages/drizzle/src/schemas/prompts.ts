import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Templatable prompts that can be versioned and used in inference requests.
 */
export const prompts = pgTable(
  'prompts',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: text().notNull(),
    description: text(),

    active_version: integer(),

    tags: jsonb().$type<Record<string, string>>().default({}),

    // Write-once, same reasoning as api_keys.creator_id: audit rows attribute
    // by joining through here, so allowing ownership transfer would silently
    // re-attribute past events.
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For prompt pagination within an organization.
    index('prompts_org_idx').on(t.organization_id, t.id),

    // For unique prompt names within an organization.
    uniqueIndex('prompts_org_name_idx').on(t.organization_id, t.name),
  ],
);

export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    prompt_id: uuid()
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    prompt: text().notNull(),
    version: integer().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For version pagination within a prompt.
    index('prompt_versions_prompt_idx').on(t.prompt_id, t.id),

    // For unique version numbers within a prompt.
    uniqueIndex('prompt_versions_prompt_version_idx').on(t.prompt_id, t.version),
  ],
);

export type PromptRow = typeof prompts.$inferSelect;
export type PromptVersionRow = typeof promptVersions.$inferSelect;
