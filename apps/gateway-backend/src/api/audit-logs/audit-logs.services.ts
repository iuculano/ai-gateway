import { probe, toPage } from '@repo/core';
import { and, db, desc, eq, gte, lt, lte, sql } from '@repo/drizzle';
import { apiKeys, auditLogs, users } from '@repo/drizzle/schemas';
import { getActorId, getCaller } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type CreateAuditLogBody,
  type CreateAuditLogResponse,
  type GetAuditLogResponse,
  type ListAuditLogsQuery,
  type ListAuditLogsResponse,
} from './audit-logs.schemas';

/**
 * The only outcome a caller can act on here.
 *
 * Audit rows are append-only and written by other services, so there is nothing
 * to refuse on the way in - only a read that finds nothing.
 */
export type GetAuditLogFailure = {
  code: 'AUDIT_LOG_NOT_FOUND';
  id: string;
};

/**
 * A database client to execute writes with: either the shared client or a
 * transaction obtained from db.transaction().
 *
 * Used so that audit log writes can execute in an existing transaction can be
 * leveraged.
 */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The user id an audit row's actor resolves to, for display joins.
 *
 * For an api_key actor the row stores the KEY's id, so the accountable human is
 * the key's creator; for every other actor type the stored id is already the
 * user. getActorId() in @repo/hono is the write-side counterpart.
 */
const ACTOR_USER_ID = sql`coalesce(${apiKeys.creator_id}, ${auditLogs.actor_id})`;

/**
 * Writes an audit log entry.
 *
 * Internal-only: this is not exposed as an endpoint, it exists for other
 * services to record events when they mutate something worth auditing.
 *
 * @param body
 * The audit event to record. occurred_at defaults to now when omitted.
 *
 * @param executor
 * The database client to write with. Pass the surrounding transaction when the
 * audit entry must commit atomically with the change it describes.
 *
 * @returns
 * A promise that resolves to the inserted audit log row.
 */
async function createAuditLog(body: CreateAuditLogBody, executor: DbExecutor = db): Promise<CreateAuditLogResponse> {
  const caller = getCaller();

  const [inserted] = await executor
    .insert(auditLogs)
    .values({
      ...body,
      organization_id: caller.organization.id,
      actor_type: caller.actor.type,
      actor_id: getActorId(caller),
      request_id: caller.request.id ?? undefined,
      ip: caller.request.ipAddress ?? undefined,
      user_agent: caller.request.userAgent ?? undefined,
      occurred_at: new Date(),
    })
    .returning();

  if (!inserted) {
    // Unexpected, database failed to persist the row...
    throw new Error('Failed to insert audit log');
  }

  const parsed = Schemas.createAuditLog.response.parse(inserted);
  return parsed;
}

/**
 * Retrieves a single audit log entry by its ID.
 *
 * @param id
 * The ID of the audit log entry to retrieve.
 *
 * @returns
 * A promise that resolves to the audit log entry corresponding to the given ID.
 */
async function getAuditLog(id: string): Promise<Result<GetAuditLogResponse, GetAuditLogFailure>> {
  const caller = getCaller();

  const [row] = await db
    .select({
      log: auditLogs,
      actor_username: users.username,
      actor_name: users.name,
      actor_email: users.email,
      actor_api_key_name: apiKeys.name,
    })
    .from(auditLogs)
    .leftJoin(apiKeys, eq(auditLogs.actor_id, apiKeys.id))
    .leftJoin(users, eq(users.id, ACTOR_USER_ID))
    .where(and(eq(auditLogs.organization_id, caller.organization.id), eq(auditLogs.id, id)));

  if (!row) {
    return err({ code: 'AUDIT_LOG_NOT_FOUND', id });
  }

  const parsed = Schemas.getAuditLog.response.parse({
    ...row.log,
    actor_name: row.actor_name ?? row.actor_username,
    actor_email: row.actor_email,
    actor_api_key_name: row.actor_api_key_name,
  });

  return ok(parsed);
}

/**
 * Retrieves a list of audit log entries, filtered by the given criteria.
 *
 * Results are returned newest-first in creation order: ids are uuidv7, so id
 * order is creation order and the after_id cursor is directly comparable -
 * keyset pagination with no anchor lookup.
 *
 * @param query
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the audit log data.
 */
async function listAuditLogs(query: ListAuditLogsQuery): Promise<ListAuditLogsResponse> {
  const caller = getCaller();

  const conditions = [
    eq(auditLogs.organization_id, caller.organization.id),
    query.after_id !== undefined ? lt(auditLogs.id, query.after_id) : undefined,
    query.status !== undefined ? eq(auditLogs.status, query.status) : undefined,
    query.actor_id !== undefined ? eq(auditLogs.actor_id, query.actor_id) : undefined,
    query.actor_type !== undefined ? eq(auditLogs.actor_type, query.actor_type) : undefined,
    query.target_type !== undefined ? eq(auditLogs.target_type, query.target_type) : undefined,
    query.target_id !== undefined ? eq(auditLogs.target_id, query.target_id) : undefined,
    query.request_id !== undefined ? eq(auditLogs.request_id, query.request_id) : undefined,
    query.created_after !== undefined ? gte(auditLogs.created_at, query.created_after) : undefined,
    query.created_before !== undefined ? lte(auditLogs.created_at, query.created_before) : undefined,
  ];

  const rows = await db
    .select({
      log: auditLogs,
      actor_username: users.username,
      actor_name: users.name,
      actor_email: users.email,
      actor_api_key_name: apiKeys.name,
    })
    .from(auditLogs)
    .leftJoin(apiKeys, eq(auditLogs.actor_id, apiKeys.id))
    .leftJoin(users, eq(users.id, ACTOR_USER_ID))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.id))
    .limit(probe(query.limit));

  // The id is projected into log by the select above, not at the top level.
  const page = toPage(rows, query.limit, (row) => row.log.id);

  const parsed = Schemas.listAuditLogs.response.parse({
    data: page.data.map((row) => ({
      ...row.log,
      actor_name: row.actor_name ?? row.actor_username,
      actor_email: row.actor_email,
      actor_api_key_name: row.actor_api_key_name,
    })),
    meta: page.meta,
  });

  return parsed;
}

export default {
  createAuditLog,
  getAuditLog,
  listAuditLogs,
};
