import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * The model catalogue: what the gateway can route to, and what it costs.
 *
 * Holds two kinds of row, told apart by `source`. Built-ins are the catalogue
 * worker's, mirrored from models.dev and replaced on every sync. Custom rows are
 * an organization's own - an Azure deployment under a name only they use, or a
 * negotiated price shadowing a built-in - and the worker never touches them.
 *
 * Nothing enforces that division at the database level; the worker's upsert is
 * scoped to `source = 'builtin'` by its conflict target, and the API is what has
 * to refuse writes in the other direction.
 */
export const models = pgTable(
  'models',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // Null for built-ins, which are global and shared by every organization.
    // Set for custom rows, which are only ever that organization's.
    //
    // 'cascade' rather than the 'restrict' logs and audit_logs use: a custom
    // model is configuration, not a record of what was spent, and there is
    // nothing to preserve once its owner is gone.
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),

    // Defaults to 'custom' because the API is what inserts without saying:
    // anything created through a request is by definition not the worker's.
    source: text({ enum: ['builtin', 'custom'] })
      .notNull()
      .default('custom'),

    name: text().notNull(), // The id the provider knows, e.g. 'gpt-5'.
    provider: text().notNull(), // 'openai', 'azure' - see PROVIDERS in @repo/core.
    display_name: text(),

    // As published upstream. 'available' is the absence of a status, not a
    // claim that anyone has checked.
    status: text({ enum: ['available', 'beta', 'deprecated'] })
      .notNull()
      .default('available'),

    // US dollars per MILLION tokens. Note that logs.input_cost / output_cost
    // are dollars outright - these are a rate, those are an amount.
    //
    // Nullable, and deliberately without a default. Null means the price is not
    // published, which is a different claim from free: 4 of OpenAI's 47 models
    // carry no price at all, and the previous NOT NULL DEFAULT 0 reported every
    // one of them as costing nothing.
    cost_input: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_output: numeric({ precision: 20, scale: 12 }).$type<number>(),
    cost_cache_read: numeric({ precision: 20, scale: 12 }).$type<number>(),

    context_limit: integer(),

    attachment: boolean().notNull().default(false),
    reasoning: boolean().notNull().default(false),
    tool_call: boolean().notNull().default(false),
    structured_output: boolean().notNull().default(false),

    // The upstream fields nothing filters on yet - description, family,
    // modalities, knowledge cutoff, release dates, cache_write, output limit.
    // Promoted to columns when something needs to query them.
    config: jsonb().$type<Record<string, unknown>>().default({}),
    tags: jsonb().$type<Record<string, string>>().default({}),

    // Set when a built-in stops appearing upstream. The row stays: a log from
    // last month still needs this price to explain what it cost.
    delisted_at: timestamp({ withTimezone: true }),

    // Last time the worker wrote this row. Null on custom rows, which no sync
    // owns. MAX() per provider is how the UI tells a provider that stopped
    // arriving from one that simply has not changed.
    synced_at: timestamp({ withTimezone: true }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two partial uniques rather than one plain one, because the same
    // provider/name can legitimately exist twice: once as the built-in and once
    // as an organization's override of it.
    //
    // These are also what make the upsert possible at all - ON CONFLICT needs a
    // unique index to conflict against, and the worker's names the first.
    uniqueIndex('models_builtin_key').on(t.provider, t.name).where(sql`${t.source} = 'builtin'`),

    // Note that Postgres treats NULLs as distinct in a unique index, so a
    // custom row with no organization_id is not constrained by this. Nothing
    // creates one today - the API defaults source to 'custom' but has no
    // organization to attach yet, which is the gap to close when tenancy
    // reaches this table.
    uniqueIndex('models_custom_key').on(t.organization_id, t.provider, t.name).where(sql`${t.source} = 'custom'`),
  ],
);

export type ModelRow = typeof models.$inferSelect;
