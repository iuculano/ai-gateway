import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { organizations } from "./organizations"

// should oraganizations_id cascade delete?
export const auditLogs = pgTable('audit_logs', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  organizations_id: uuid().notNull().references(() => organizations.id),
  timestamp: timestamp({ withTimezone: true }).notNull(),
  actor: text().notNull(),
  method: text().notNull(),
  route: text().notNull(),
  status_code: integer().notNull(),
  request_id: text().notNull(),
  ip: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
