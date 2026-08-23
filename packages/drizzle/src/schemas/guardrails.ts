import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/** Settings for a 'regex' guardrail. `flags` excludes g and y - see compile() in the service. */
export interface RegexGuardrailConfig {
  pattern: string;
  flags?: string;
}

/**
 * The type-specific shape stored in `guardrails.config`.
 */
export type GuardrailConfig = RegexGuardrailConfig;

/**
 * Stores every guardrail type together so enforcement can load a tenant's
 * enabled rules in one indexed query. Because Postgres cannot enforce each
 * type's JSON shape, config is validated at the API boundary and again on read.
 */
export const guardrails = pgTable(
  'guardrails',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: text().notNull(),
    description: text(),

    // Discriminates config without requiring a new table per guardrail type.
    type: text({ enum: ['regex'] }).notNull(),

    // `both` checks each side independently so matches cannot cross their boundary.
    target: text({ enum: ['request', 'response', 'both'] }).notNull(),

    // Evaluation reports the action; the caller currently enforces it.
    action: text({ enum: ['block', 'flag'] })
      .notNull()
      .default('block'),

    config: jsonb().$type<GuardrailConfig>().notNull(),

    enabled: boolean().notNull().default(true),

    // Write-once so later ownership changes cannot reattribute audit history.
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Keep disabled rows out of the inference-path index.
    index('guardrails_org_enabled_idx').on(t.organization_id, t.id).where(sql`${t.enabled}`),

    // The dashboard also needs disabled rows.
    index('guardrails_org_idx').on(t.organization_id, t.id),
  ],
);

export type GuardrailRow = typeof guardrails.$inferSelect;
