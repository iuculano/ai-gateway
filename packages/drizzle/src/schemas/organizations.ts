import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Representation of a user pool, essentially.
 */
export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  slug: text().unique(),
  name: text().notNull(),
  status: text().notNull().default('active'),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Allows linking an organization to an external identity provider.
 *
 * The identity provider should provide some kind of stable identifier when it
 * creates a token. This can be used to link back to the app owned organization.
 */
export const organizationIdpLinks = pgTable('organization_idp_links', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  organization_id: uuid().references(() => organizations.id).notNull(),
  external_organization_id: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_idx").on(table.external_organization_id)
]);
