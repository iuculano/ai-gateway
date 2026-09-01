import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    endpoint: text().notNull(),
    filter: jsonb().$type<Record<string, string>>(),
    tags: jsonb().$type<Record<string, string>>(),
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // For webhook pagination within an organization.
    index('webhooks_org_idx').on(t.organization_id, t.id),

    // For filtering webhooks by tags.
    index('webhooks_tags_idx').using('gin', t.tags),
  ],
);

export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    webhook_id: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    log_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // For outbox pagination within a webhook.
    index('webhook_outbox_webhook_idx').on(t.webhook_id, t.id),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    outbox_id: uuid().notNull(),
    webhook_id: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    status_code: integer().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // For delivery pagination within a webhook.
    index('webhook_deliveries_webhook_idx').on(t.webhook_id, t.id),
  ],
);

export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookOutboxRow = typeof webhookOutbox.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
