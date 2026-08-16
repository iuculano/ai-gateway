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
    // Write-once: set at creation, never updated. Audit attribution depends on
    // it - audit_logs rows for an api_key actor store the KEY's id, and the
    // accountable human is derived by joining through here at read time. Allow
    // this to change (ownership transfer) and past events silently re-attribute
    // to the new owner; that is the point at which audit_logs would need to
    // record the human directly instead.
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),
    scopes: text().notNull().default(''),
    rate_limit_requests: integer(),
    rate_limit_window: integer(),
    // Reserved for future IP-allowlist support. This value is currently stored
    // and returned as configuration only: authentication intentionally does not
    // enforce it yet. Do not treat allowed_ips as a security control until that
    // support is implemented.
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
    // Literally what we're going to search by, always.
    uniqueIndex('api_keys_key_hash_idx').on(t.key_hash),

    index('api_keys_org_active_idx').on(t.organization_id).where(sql`${t.revoked_at} is null`),
    check('api_keys_key_hash_len', sql`length(${t.key_hash}) = 64`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
