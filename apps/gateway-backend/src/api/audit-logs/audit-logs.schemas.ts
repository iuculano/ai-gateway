import { z } from '@hono/zod-openapi';
import { auditLogs } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod';

const auditLogShape = createSelectSchema(auditLogs).omit({
  organization_id: true,
});

// Read endpoints resolve the actor_id to the user's display identity at
// query time. Null for system actors and for actors that no longer exist.
const auditLogWithActorShape = auditLogShape.extend({
  actor_name: z.string().nullable(),
  actor_email: z.string().nullable(),
});

const getAuditLog = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: auditLogWithActorShape,
});

const listAuditLogs = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(),

    status: z.enum(['success', 'failure']).optional(),
    actor_id: z.uuid().optional(),
    actor_type: z.enum(['user', 'api_key', 'system']).optional(),
    target_type: z.string().optional(),
    target_id: z.uuid().optional(),
    request_id: z.string().optional(),
    created_after: z.coerce.date().optional(),
    created_before: z.coerce.date().optional(),
  }),

  response: z.object({
    data: z.array(auditLogWithActorShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

// This is a bit of a horrorshow...
const auditEventValues = [
  'api-keys.created',
  'api-keys.updated',
  'api-keys.revoked',
  'guardrails.created',
  'guardrails.updated',
  'guardrails.deleted',
] as const;

const auditTargetTypeValues = ['api_key', 'guardrail', 'organization', 'user'] as const;

type AuditTargetType = (typeof auditTargetTypeValues)[number];
type AuditEvent = (typeof auditEventValues)[number];

const createAuditLogBase = createInsertSchema(auditLogs).omit({
  id: true, // server-generated
  actor_id: true, // supplied from the caller
  actor_type: true, // supplied from the caller
  organization_id: true, // supplied from the caller
  user_agent: true, // supplied from the caller
  request_id: true, // supplied from the caller
  ip: true, // supplied from the caller
  occurred_at: true, // server-generated
  created_at: true, // server-generated
});

// One member of the createAuditLog body union: an event pinned to the target
// type it must carry. Zod validates the member the `event` literal selects, so
// the pairing is enforced at runtime, and z.infer carries it to callers. Add a
// targetless event as an inline member with `target_type: z.null().optional()`.
const event = <E extends AuditEvent, T extends AuditTargetType>(name: E, target: T) =>
  createAuditLogBase.extend({
    event: z.literal(name),
    target_type: z.literal(target),
  });

const createAuditLog = createSchema({
  body: z.discriminatedUnion('event', [
    event('api-keys.created', 'api_key'),
    event('api-keys.updated', 'api_key'),
    event('api-keys.revoked', 'api_key'),
    event('guardrails.created', 'guardrail'),
    event('guardrails.updated', 'guardrail'),
    event('guardrails.deleted', 'guardrail'),
  ]),

  response: auditLogShape,
});

export type GetAuditLogParams = z.infer<typeof getAuditLog.params>;
export type GetAuditLogResponse = z.infer<typeof getAuditLog.response>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogs.query>;
export type ListAuditLogsResponse = z.infer<typeof listAuditLogs.response>;
export type CreateAuditLogBody = z.infer<typeof createAuditLog.body>;
export type CreateAuditLogResponse = z.infer<typeof createAuditLog.response>;

export default {
  getAuditLog,
  listAuditLogs,
  createAuditLog,
};
