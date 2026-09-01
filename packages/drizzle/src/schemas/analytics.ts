import { bigint, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Hourly pre-aggregation of `logs`.
 *
 * Every row is derivable from `logs` by re-running the refresh.
 */
export const analyticsHourly = pgTable(
  'analytics_hourly',
  {
    // Deleting an organization shouldn't destroy the record of what it used.
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    bucket: timestamp({ withTimezone: true }).notNull(),

    model: text().notNull(),
    provider: text().notNull(),
    status: text({ enum: ['incomplete', 'complete', 'failed'] }).notNull(),

    actor_type: text({ enum: ['user', 'api_key'] }).notNull(),
    actor_id: uuid().notNull(),

    // bigint, not integer. A sum over 5M rows leaves int4 range immediately.
    requests: bigint({ mode: 'number' }).notNull(),
    input_tokens: bigint({ mode: 'number' }).notNull().default(0),
    output_tokens: bigint({ mode: 'number' }).notNull().default(0),

    input_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),
    output_cost: numeric({ precision: 20, scale: 12 }).$type<number>().notNull().default(0),

    latency_sum: bigint({ mode: 'number' }).notNull().default(0),
    latency_count: bigint({ mode: 'number' }).notNull().default(0),
    latency_min: integer(),
    latency_max: integer(),

    refreshed_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // For unique hourly analytics groups.
    unique('analytics_hourly_key').on(
      t.organization_id,
      t.bucket,
      t.model,
      t.provider,
      t.status,
      t.actor_type,
      t.actor_id,
    ),
  ],
);

export type AnalyticsHourlyRow = typeof analyticsHourly.$inferSelect;
