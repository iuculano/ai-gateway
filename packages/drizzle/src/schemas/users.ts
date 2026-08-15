import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'deleted']);

/**
 * Representation of a human.
 *
 * This table will be populated just-in-time when a user logs in - it does not
 * sync. One row per human.
 *
 * This is intended to give a stable database-local identity to a user, it is
 *
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    username: text().notNull(),
    email: text().notNull(),
    name: text(),
    status: userStatus().notNull().default('active'), // 'deleted' = tombstone JIT path must check this
    // Legacy migration bridge. New identities live in user_identities; an old
    // row is claimed once by its first issuer-qualified login and then cleared.
    external_id: text(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Keeps unclaimed legacy identities unique while allowing many migrated
    // rows whose external_id has been cleared to null.
    uniqueIndex('users_external_idx').on(t.external_id),
  ],
);

export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    external_idp: text().notNull(),
    external_id: text().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('identities_external_idx').on(t.external_idp, t.external_id),
    index('identities_user_idx').on(t.user_id),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type UserIdentityRow = typeof userIdentities.$inferSelect;
