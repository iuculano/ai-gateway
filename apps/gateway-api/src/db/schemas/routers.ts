import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { type RulesShape  } from '../../api/routers/routers.schemas';
import { sql } from '@lib/drizzle';

export const routers = pgTable('routers', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull().unique(),
  description: text(),
  active_version: integer(),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow()
});

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
  rules: jsonb().$type<RulesShape>(),

  version: integer().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
