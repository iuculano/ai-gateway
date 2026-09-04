import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const traces = pgTable(
  'traces',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    // hex format of W3C trace id, 16 bytes / 32 hex chars.
    trace_id: text().notNull(),

    name: text(),
    status: text({ enum: ['partial', 'complete', 'failed'] })
      .notNull()
      .default('partial'),

    started_at: timestamp({ withTimezone: true }).notNull(),
    ended_at: timestamp({ withTimezone: true }),
    duration_ms: integer(),

    total_input_tokens: integer().notNull().default(0),
    total_output_tokens: integer().notNull().default(0),
    total_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
    log_count: integer().notNull().default(0),
    span_count: integer().notNull().default(0),
    tool_count: integer().notNull().default(0),
    error_count: integer().notNull().default(0),

    tags: jsonb().$type<Record<string, string>>().notNull().default({}),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For unique W3C trace ids within an organization and ingestion upserts.
    uniqueIndex('traces_org_trace_idx').on(t.organization_id, t.trace_id),

    // For trace pagination by application start time within an organization.
    index('traces_org_started_idx').on(t.organization_id, t.started_at, t.id),
  ],
);

export const traceSpans = pgTable(
  'trace_spans',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid().notNull(),

    // Again, hex format, can't be a UUID
    trace_id: text().notNull(),

    // Same
    span_id: text().notNull(),

    // Same, might be empty string or null
    parent_span_id: text(),

    service_name: text(),
    scope_name: text(),
    scope_version: text(),
    name: text().notNull(),
    kind: text({ enum: ['llm', 'tool', 'retrieval', 'embedding', 'rerank', 'workflow', 'custom'] })
      .notNull()
      .default('custom'),
    status: text({ enum: ['unset', 'ok', 'error'] })
      .notNull()
      .default('unset'),

    started_at: timestamp({ withTimezone: true }).notNull(),
    ended_at: timestamp({ withTimezone: true }),
    duration_ms: integer(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For idempotent exporter retries within an organization and trace.
    uniqueIndex('trace_spans_org_trace_span_idx').on(t.organization_id, t.trace_id, t.span_id),

    foreignKey({
      name: 'trace_spans_trace_fk',
      columns: [t.organization_id, t.trace_id],
      foreignColumns: [traces.organization_id, traces.trace_id],
    }).onDelete('cascade'),

    // For rendering application spans in waterfall order.
    index('trace_spans_org_trace_started_idx').on(t.organization_id, t.trace_id, t.started_at, t.id),
  ],
);

export type TraceRow = typeof traces.$inferSelect;
export type TraceSpanRow = typeof traceSpans.$inferSelect;
