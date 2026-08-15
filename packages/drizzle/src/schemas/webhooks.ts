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

    // Which events this endpoint wants, as a set of equality matches against
    // the log record - `{"event": "api-keys.created"}`. jsonb rather than a
    // join table because it is read on every delivery decision and never
    // queried across webhooks.
    filter: jsonb().$type<Record<string, string>>(),

    // Caller-supplied labels, filtered on with the `@>` containment operator -
    // see `listWebhooks`. Indexed below, which is the whole reason this is
    // jsonb and not text.
    tags: jsonb().$type<Record<string, string>>(),

    // Same write-once reasoning as api_keys.creator_id: deliveries are
    // attributed by joining through here, so allowing ownership transfer would
    // silently re-attribute past deliveries.
    creator_id: uuid().references(() => users.id, { onDelete: 'set null' }),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Every read is scoped to one organization and ordered by id descending -
    // the cursor pagination in `listWebhooks`.
    index('webhooks_org_idx').on(t.organization_id, t.id),

    // GIN, because `tags @> '{"env":"prod"}'::jsonb` cannot use a btree.
    index('webhooks_tags_idx').using('gin', t.tags),
  ],
);

/**
 * Work queued for delivery: one row per (webhook, log) pair that matched.
 *
 * Separate from `webhook_deliveries` because this is the queue and that is the
 * history - a row here is claimed and removed, a row there is never touched
 * again.
 */
export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    webhook_id: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),

    // No foreign key: audit_logs uses `onDelete: 'restrict'` for its own
    // organization reference and is effectively append-only, but the outbox is
    // drained and pruned on a different schedule. Pointing at it with a real
    // constraint would make pruning logs depend on queue state.
    log_id: uuid().notNull(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_outbox_webhook_idx').on(t.webhook_id, t.id)],
);

/**
 * Delivery attempts, kept after the outbox row is gone.
 *
 * `status_code` is the HTTP status the endpoint returned; a row exists whether
 * or not the attempt succeeded, which is what makes this a history rather than
 * a retry queue.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // The outbox row this attempt came from. Not a foreign key for the same
    // reason as above - outbox rows are deleted once drained, and that must not
    // take the delivery history with them.
    outbox_id: uuid().notNull(),

    webhook_id: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),

    status_code: integer().notNull(),

    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_webhook_idx').on(t.webhook_id, t.id)],
);

export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookOutboxRow = typeof webhookOutbox.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
