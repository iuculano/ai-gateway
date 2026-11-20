import { sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

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
    slug: text().notNull().unique(), // For unique organization slugs.
    status: text({ enum: ['active', 'suspended', 'deleted'] })
      .notNull()
      .default('active'),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For organization lookups from an external provider.
    uniqueIndex('orgs_external_idx').on(t.external_idp, t.external_id),
  ],
);

/**
 * The users who have acted under an organization.
 *
 * A row is written the first time a user authenticates under an organization.
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Organization first, so one organization's lookups stay on the key.
    primaryKey({ columns: [t.organization_id, t.user_id] }),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
