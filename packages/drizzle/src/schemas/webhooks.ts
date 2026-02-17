import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { logs } from './logs';

/**
 * Webhook configurations.
 */
export const webhooks = pgTable('webhooks', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull().unique(),
  description: text(),
  endpoint: text().notNull(),
  filter: jsonb().$type<Record<string, string>>().default({}),
  tags: jsonb().$type<Record<string, string>>().default({}),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow()
});

/**
 * Queue for logs that need to be processed by a webhook.
 */
export const webhookOutbox = pgTable('webhook_outbox', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  webhook_id: uuid().notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  log_id: uuid().notNull().references(() => logs.id, { onDelete: 'cascade' }),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Results of a webhook delivery attempt.
 */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  outbox_id: uuid().notNull().references(() => webhookOutbox.id),
  webhook_id: uuid().notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  status_code: integer().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
