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
 * The `config` blob, shaped by the row's `type`.
 *
 * A union of one today. It stays a union rather than collapsing to the single
 * member so that adding a type is an edit here plus a new branch wherever
 * config is read - which is what the discriminator is for.
 */
export type GuardrailConfig = RegexGuardrailConfig;

/**
 * One row per configured guardrail, of every type.
 *
 * ONE table with a `type` discriminator and a jsonb `config`, rather than a
 * table per guardrail type. The deciding factor is the read, not the write:
 * enforcement asks "every enabled guardrail for this organization" on every
 * inference request, which is one indexed scan here, and a UNION that gains a
 * branch per type in the alternative - a change in the hot path every time a
 * guardrail type is added.
 *
 * The cost is that postgres cannot constrain the shape of `config`; it knows
 * only that it is json. That check moves to the API boundary, where zod
 * validates each type's config against the schema its `type` selects - see
 * guardrails.schemas.ts. Rows written by anything other than that boundary are
 * therefore unvalidated, which is why evaluation re-parses config on read
 * rather than trusting it.
 *
 * Every query against this table must carry an organization predicate. This
 * table says what may pass through the gateway, so cross-tenant reads are a
 * security boundary rather than merely incorrect results.
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

    // The discriminator `config` is read against. Widening this enum is what
    // adding a guardrail type looks like at the storage layer - the table
    // itself does not change.
    type: text({ enum: ['regex'] }).notNull(),

    // Which side of the exchange this runs against. 'both' is evaluated as two
    // independent checks rather than one pass over concatenated text, so a
    // result can say which side tripped and a match cannot straddle the seam
    // between them.
    target: text({ enum: ['request', 'response', 'both'] }).notNull(),

    // What a violation should cause. Nothing enforces this yet - evaluation
    // reports it and the caller decides - but it is recorded per guardrail
    // because that decision belongs to the rule rather than to the call site.
    action: text({ enum: ['block', 'flag'] })
      .notNull()
      .default('block'),

    config: jsonb().$type<GuardrailConfig>().notNull(),

    enabled: boolean().notNull().default(true),

    // Write-once, same reasoning as api_keys.creator_id: audit rows attribute
    // by joining through here, so allowing ownership transfer would silently
    // re-attribute past events.
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The enforcement read: every enabled guardrail for one organization.
    // Partial, because disabled rows are never on that path and keeping them
    // out of the index is the entire point of it.
    index('guardrails_org_enabled_idx').on(t.organization_id, t.id).where(sql`${t.enabled}`),

    // The dashboard read: cursor pagination over the full set, disabled rows
    // included. The partial index above cannot serve this one.
    index('guardrails_org_idx').on(t.organization_id, t.id),
  ],
);

export type GuardrailRow = typeof guardrails.$inferSelect;
