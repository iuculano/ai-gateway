import { desc, sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organizations } from "./organizations"


export const apiKeys = pgTable('api_keys', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  //organizations_id: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  description: text(),
  key_hash: text().notNull(), // HMAC-SHA256
  //expires_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
