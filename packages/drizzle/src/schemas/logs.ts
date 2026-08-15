import { sql } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * One row per inference request.
 *
 * The payloads themselves are NOT here. They live in object storage, zstd
 * compressed, as two separate objects - the request and the response - and the
 * columns below hold their keys. Two objects rather than one because the two
 * are read independently: a dashboard listing prompts never needs the
 * completions, and `ai-log-omit-request` / `ai-log-omit-response` let a caller
 * suppress either side on its own.
 *
 * These rows carry prompts and completions, which is the most sensitive data
 * the system holds. Every query against this table must therefore carry an
 * explicit organization predicate.
 */
export const logs = pgTable(
  'logs',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // 'restrict' rather than 'cascade', matching audit_logs: deleting an
    // organization must not silently destroy the record of what it spent.
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    model: text().notNull(),
    provider: text().notNull(),

    // 'incomplete' is written before the provider is called, so a request that
    // dies mid-flight leaves a row behind rather than vanishing.
    status: text({ enum: ['incomplete', 'complete', 'failed'] })
      .notNull()
      .default('incomplete'),

    input_tokens: integer(),
    output_tokens: integer(),

    input_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
    output_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),

    response_time_ms: integer(),

    // Object storage keys, one per payload. Null means the object was never
    // written - either the caller omitted that side, or the request failed
    // before there was anything to write. Null is therefore meaningful and is
    // what the /request and /response endpoints turn into a 404.
    request_object_reference: text(),
    response_object_reference: text(),

    // Caller-supplied labels, filtered with the `@>` containment operator.
    // jsonb rather than text for exactly that reason - see the GIN index below.
    tags: jsonb().$type<Record<string, string>>(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Every read is scoped to one organization and ordered by id - the cursor
    // pagination in listLogs walks this in both directions.
    index('logs_org_idx').on(t.organization_id, t.id),

    // listLogs filters on these far more often than anything else, and a
    // dashboard's default view is "this org, this model, newest first".
    index('logs_org_model_idx').on(t.organization_id, t.model, t.id),
    index('logs_org_status_idx').on(t.organization_id, t.status, t.id),

    // GIN, because `tags @> '{"env":"prod"}'::jsonb` cannot use a btree.
    index('logs_tags_idx').using('gin', t.tags),
  ],
);

export type LogRow = typeof logs.$inferSelect;
