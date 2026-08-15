import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The tenant / user-pool.
 *
 * This is basically just a thin record for an organization/tenant and is
 * intended to be connected to an external identity provider.
 *
 * It will be populated just-in-time when a user logs in - it does not sync.
 *
 * This is intended to give a stable database-local identity to an organization,
 * and make it easier for things like mass data deletion to work.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    external_id: text().notNull(),
    external_idp: text().notNull(), // no default: under federation, force callers to name the issuer

    name: text().notNull(), // cached from IdP, display-only
    slug: text().notNull().unique(),
    status: text({ enum: ['active', 'suspended', 'deleted'] })
      .notNull()
      .default('active'),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('orgs_external_idx').on(t.external_idp, t.external_id)],
);

export type OrganizationRow = typeof organizations.$inferSelect;
