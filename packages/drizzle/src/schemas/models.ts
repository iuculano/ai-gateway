import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const models = pgTable(
  'models',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // Optional owner for custom models, built-ins are global.
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    source: text({ enum: ['builtin', 'custom'] })
      .notNull()
      .default('custom'),
    name: text().notNull(), // The id the provider knows, e.g. 'gpt-5'.
    provider: text().notNull(), // The provider id, such as 'openai' or 'azure'.
    display_name: text(),
    status: text({ enum: ['available', 'beta', 'deprecated'] })
      .notNull()
      .default('available'),
    cost_input: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_output: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_cache_read: numeric({ precision: 20, scale: 12 }).$type<number>(),
    context_limit: integer(),
    attachment: boolean().notNull().default(false),
    reasoning: boolean().notNull().default(false),
    tool_call: boolean().notNull().default(false),
    structured_output: boolean().notNull().default(false),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    tags: jsonb().$type<Record<string, string>>().default({}),
    delisted_at: timestamp({ withTimezone: true }),
    synced_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // For unique built-in models.
    uniqueIndex('models_builtin_key').on(t.provider, t.name).where(sql`${t.source} = 'builtin'`),

    // For unique custom models within an organization.
    uniqueIndex('models_custom_key').on(t.organization_id, t.provider, t.name).where(sql`${t.source} = 'custom'`),
  ],
);

export type ModelRow = typeof models.$inferSelect;
