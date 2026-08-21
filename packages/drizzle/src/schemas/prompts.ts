import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Templatable prompts that can be versioned and used in inference requests.
 *
 * Every query against this table must carry an organization predicate. A prompt
 * is the text the gateway will put in front of a model on the caller's behalf,
 * so a cross-tenant read here leaks one organization's instructions into
 * another's inference - a security boundary rather than merely wrong results.
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

    // Which version callers get when they ask for the prompt without naming
    // one. Nullable because a prompt exists before its first version does, and
    // deliberately not a foreign key: it holds the `version` ordinal rather
    // than a prompt_versions.id, so that the pointer reads the same way the
    // API addresses versions.
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
    // Cursor pagination over one organization's prompts.
    index('prompts_org_idx').on(t.organization_id, t.id),

    // Scoped to the organization rather than global. A name is how a caller
    // refers to their own prompt, so two organizations picking "support-triage"
    // is ordinary rather than a collision - a global unique would let one
    // tenant deny a name to every other.
    uniqueIndex('prompts_org_name_idx').on(t.organization_id, t.name),
  ],
);

/**
 * Versioned prompt configurations.
 *
 * This is where the actual prompt data is stored.
 *
 * No organization_id of its own: a version is reachable only through its
 * parent, so scoping joins to `prompts` and checks the predicate there. The
 * same shape webhook_deliveries uses, and it keeps the tenancy answer in one
 * place instead of two that can disagree.
 */
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
    // Cursor pagination over one prompt's versions.
    index('prompt_versions_prompt_idx').on(t.prompt_id, t.id),

    // The actual guarantee behind version numbering. createPromptVersion
    // computes max+1 under a lock on the parent row, which serializes the
    // readers that take it - this is what stops anything that does not.
    uniqueIndex('prompt_versions_prompt_version_idx').on(t.prompt_id, t.version),
  ],
);

export type PromptRow = typeof prompts.$inferSelect;
export type PromptVersionRow = typeof promptVersions.$inferSelect;
