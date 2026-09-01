import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

export const guardrails = pgTable(
  'guardrails',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    type: text({ enum: ['regex'] }).notNull(),
    target: text({ enum: ['request', 'response', 'both'] }).notNull(),
    action: text({ enum: ['block', 'flag'] })
      .notNull()
      .default('block'),
    config: jsonb().$type<Record<string, unknown>>().notNull(),
    enabled: boolean().notNull().default(true),
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For enabled guardrail lookups during inference.
    index('guardrails_org_enabled_idx').on(t.organization_id, t.id).where(sql`${t.enabled}`),

    // For guardrail pagination within an organization.
    index('guardrails_org_idx').on(t.organization_id, t.id),
  ],
);

export type GuardrailRow = typeof guardrails.$inferSelect;
