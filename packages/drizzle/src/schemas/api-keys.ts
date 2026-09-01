import { sql } from 'drizzle-orm';
import { check, cidr, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    key_hash: text().notNull(),
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),
    scopes: text().notNull().default(''),
    rate_limit_requests: integer(),
    rate_limit_window: integer(),
    allowed_ips: cidr().array(),
    expires_at: timestamp({ withTimezone: true }),
    revoked_at: timestamp({ withTimezone: true }),
    revoked_by: uuid().references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For API key lookups.
    uniqueIndex('api_keys_key_hash_idx').on(t.key_hash),

    // For active API keys within an organization.
    index('api_keys_org_active_idx').on(t.organization_id).where(sql`${t.revoked_at} is null`),
    check('api_keys_key_hash_len', sql`length(${t.key_hash}) = 64`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
