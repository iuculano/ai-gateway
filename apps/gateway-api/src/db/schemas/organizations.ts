import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';


export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  slug: text().unique(),
  name: text().notNull(),
  status: text().notNull().default('active'),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const organizationIdpLinks = pgTable('organization_idp_links', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),  
  organization_id: uuid().references(() => organizations.id).notNull(),
  external_organization_id: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // These lookups are going to be super common
  uniqueIndex("email_idx").on(
    table.external_organization_id
  )
]);
