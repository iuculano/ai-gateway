import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Combines the global model catalogue with custom models. The catalogue worker
 * only updates rows marked as built-in.
 */
export const models = pgTable(
  'models',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // Optional owner for custom models; built-ins are global. Owned models
    // cascade because they are configuration, not historical spend records.
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),

    // API inserts default to custom; the catalogue worker sets builtin explicitly.
    source: text({ enum: ['builtin', 'custom'] })
      .notNull()
      .default('custom'),

    name: text().notNull(), // The id the provider knows, e.g. 'gpt-5'.
    provider: text().notNull(), // The provider id, such as 'openai' or 'azure'.
    display_name: text(),

    // `available` means upstream published no special status, not that health was checked.
    status: text({ enum: ['available', 'beta', 'deprecated'] })
      .notNull()
      .default('available'),

    // US dollars per million tokens. Null means unpublished, not free.
    cost_input: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_output: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_cache_read: numeric({ precision: 20, scale: 12 }).$type<number>(),

    context_limit: integer(),

    attachment: boolean().notNull().default(false),
    reasoning: boolean().notNull().default(false),
    tool_call: boolean().notNull().default(false),
    structured_output: boolean().notNull().default(false),

    // Preserve upstream metadata until a query warrants dedicated columns.
    config: jsonb().$type<Record<string, unknown>>().default({}),
    tags: jsonb().$type<Record<string, string>>().default({}),

    // Keep absent built-ins for historical cost calculations.
    delisted_at: timestamp({ withTimezone: true }),

    // Last catalogue confirmation; null for custom rows.
    synced_at: timestamp({ withTimezone: true }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Built-ins are unique globally; owned custom models are unique per tenant,
    // allowing a tenant to reuse a built-in provider/name.
    uniqueIndex('models_builtin_key').on(t.provider, t.name).where(sql`${t.source} = 'builtin'`),

    // PostgreSQL treats null organization ids as distinct, so unowned custom
    // models are not constrained by this index.
    uniqueIndex('models_custom_key').on(t.organization_id, t.provider, t.name).where(sql`${t.source} = 'custom'`),
  ],
);

export type ModelRow = typeof models.$inferSelect;
