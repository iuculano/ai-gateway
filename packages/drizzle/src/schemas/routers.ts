
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';

/**
 * Special type of model that routes requests to different models based on
 * rules.
 */
export const routers = pgTable('routers', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull().unique(),
  description: text(),
  active_version: integer(),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow()
});

/**
 * Versioned router configurations.
 *
 * This is where the actual routing rules are stored.
 */
export const routerVersions = pgTable('router_versions', {
  id: uuid().primaryKey().default(sql`uuidv7()`),

  router_id: uuid()
    .notNull()
    .references(() => routers.id, { onDelete: 'cascade' }),

  // Not sure about serializing the entire configuration as JSON, but it is
  // ridiculously simpler to deal with this way...
  //
  // I don't think we'll ever query against this, it'll just be retrieved in
  // full.
  rules: jsonb(),

  version: integer().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
