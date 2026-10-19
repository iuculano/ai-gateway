import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const MODEL_TYPES = ['chat', 'embedding', 'decision'] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export const models = pgTable(
  'models',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    name: text().notNull(), // The id the provider knows, e.g. 'gpt-5'.
    provider: text().notNull(), // The provider id, such as 'openai' or 'azure'.
    type: text({ enum: MODEL_TYPES }).notNull().default('chat'),
    redirect_to: text(), // so we can add our own models ahead of models.dev and redirect if the real deal is different
    display_name: text(),
    status: text({ enum: ['available', 'beta', 'deprecated'] })
      .notNull()
      .default('available'),
    cost_input: numeric({ precision: 20, scale: 12, mode: 'number' }),
    cost_output: numeric({ precision: 20, scale: 12, mode: 'number' }),
    cost_cache_read: numeric({ precision: 20, scale: 12, mode: 'number' }),
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
  (t) => [uniqueIndex('models_provider_name_type_key').on(t.provider, t.name, t.type)],
);

export type ModelRow = typeof models.$inferSelect;
