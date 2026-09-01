import { sql } from 'drizzle-orm';
import { check, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),

    // Need to be careful here - 'restrict' is used instead of 'cascade' because
    // we don't want to oblitate audit logs if an organization is deleted.
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    actor_type: text({ enum: ['user', 'api_key', 'system'] }).notNull(),
    actor_id: uuid(), // can be null for system type
    event: text().notNull(), // Enum for what happened, like: 'api-keys.created', 'users.updated', etc.
    target_type: text(), // 'user', 'api_key', ... (null for targetless events, e.g. 'auth.login')
    target_id: uuid(),
    difference: jsonb(), // the diff - fields, old/new values.
    metadata: jsonb(), // Escape hatch for additional event-specific data.

    status: text({ enum: ['success', 'failure'] }).notNull(),

    request_id: text(),
    ip: inet(),
    user_agent: text(),

    occurred_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // For pagination.
    index('audit_org_id_idx').on(t.organization_id, t.id),

    // For events happened within an organization.
    index('audit_org_time_idx').on(t.organization_id, t.created_at),

    // For querying actions performed by a specific actor.
    index('audit_org_actor_time_idx').on(t.organization_id, t.actor_id, t.created_at),

    // For who touched a particular target and when.
    //
    // Note that we don't need to index on organization_id here because
    // target_id is already unique across orgs.
    index('audit_target_idx').on(t.target_type, t.target_id, t.occurred_at),

    // So we don't have a full table scan because someone wants to correlate
    // and audit log with a request_id.
    index('audit_request_idx').on(t.request_id).where(sql`request_id IS NOT NULL`),

    // Only system events may omit an actor id.
    check('audit_actor_id_presence', sql`actor_type = 'system' OR actor_id IS NOT NULL`),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
