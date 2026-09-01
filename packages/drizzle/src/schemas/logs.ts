import { sql } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Inference log table for all requests that pass through the gateway.
 *
 * Note that the actual data is stored in object storage, and this table only
 * contains the metadata and references to those objects.
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
    status: text({ enum: ['incomplete', 'complete', 'failed'] })
      .notNull()
      .default('incomplete'),
    actor_type: text({ enum: ['user', 'api_key'] }).notNull(),
    actor_id: uuid().notNull(),
    input_tokens: integer(),
    output_tokens: integer(),
    input_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
    output_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
    response_time_ms: integer(),
    request_object_reference: text(),
    response_object_reference: text(),
    tags: jsonb().$type<Record<string, string>>(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For log pagination within an organization.
    index('logs_org_idx').on(t.organization_id, t.id),

    // For filtering logs by model.
    index('logs_org_model_idx').on(t.organization_id, t.model, t.id),

    // For filtering logs by status.
    index('logs_org_status_idx').on(t.organization_id, t.status, t.id),

    // For filtering logs by tags.
    index('logs_tags_idx').using('gin', t.tags.op('jsonb_path_ops')),

    // For time-based analytics within an organization.
    index('logs_org_created_idx').on(t.organization_id, t.created_at),
  ],
);

export type LogRow = typeof logs.$inferSelect;
