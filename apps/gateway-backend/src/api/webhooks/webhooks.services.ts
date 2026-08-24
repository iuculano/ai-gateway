import { diffFields, parseTags } from '@repo/core';
import { and, db, desc, eq, lt, sql } from '@repo/drizzle';
import { webhookDeliveries, webhookOutbox, webhooks } from '@repo/drizzle/schemas';
import { getAccountableUserId, getCaller, getLogger } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import AuditLogServices from '../audit-logs/audit-logs.services';
import Schemas, {
  type CreateWebhookBody,
  type CreateWebhookResponse,
  type DeleteWebhookResponse,
  type GetWebhookResponse,
  type ListWebhookDeliveriesQuery,
  type ListWebhookDeliveriesResponse,
  type ListWebhookOutboxQuery,
  type ListWebhookOutboxResponse,
  type ListWebhooksQuery,
  type ListWebhooksResponse,
  type UpdateWebhookBody,
  type UpdateWebhookResponse,
} from './webhooks.schemas';

/**
 * The one outcome a caller can act on: the webhook is not theirs to see.
 *
 * Declared per operation rather than shared, so that a code added to one of
 * them cannot silently widen the others. They are identical today because the
 * three operations genuinely refuse for the same single reason.
 *
 * Everything else here - a failed query, a row that will not parse, an insert
 * that returns nothing - is the system malfunctioning rather than an answer,
 * and rejects.
 */
export type EnqueueDeliveryFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

export type GetWebhookFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

export type UpdateWebhookFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

export type DeleteWebhookFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

/**
 * Retrieves a single webhook by its ID.
 *
 * Scoping the read to the caller's organization rather than checking after the
 * fact makes a cross-tenant id indistinguishable from a missing one - both
 * answer WEBHOOK_NOT_FOUND, and neither confirms the row exists.
 *
 * @param id
 * The ID of the webhook to retrieve.
 */
async function getWebhook(id: string): Promise<Result<GetWebhookResponse, GetWebhookFailure>> {
  const caller = getCaller();

  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.organization_id, caller.organization.id), eq(webhooks.id, id)));

  if (!row) {
    return err({ code: 'WEBHOOK_NOT_FOUND', id });
  }

  const parsed = Schemas.getWebhook.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a list of webhooks, filtered by the given criteria.
 *
 * @param request
 * The request object containing the filter criteria.
 */
async function listWebhooks(request: ListWebhooksQuery): Promise<ListWebhooksResponse> {
  const caller = getCaller();
  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    request.tags ? sql`${webhooks.tags} @> ${tagsToFilter}::jsonb` : undefined,
    request.after_id ? lt(webhooks.id, request.after_id) : undefined,
  ];

  const result = await db
    .select()
    .from(webhooks)
    .where(and(...conditions))
    .orderBy(desc(webhooks.id))
    .limit(request.limit + 1);

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    result.pop(); // Remove the pagination probe row.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listWebhooks.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new webhook in the database.
 *
 * Tenant and creator are derived from the authenticated caller rather than the
 * request body.
 *
 * @param request
 * The request object containing the webhook data to create.
 */
async function createWebhook(request: CreateWebhookBody): Promise<CreateWebhookResponse> {
  const caller = getCaller();

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhooks)
      .values({
        ...request,
        organization_id: caller.organization.id,
        creator_id: getAccountableUserId(caller),
      })
      .returning();

    if (!row) {
      throw new Error('Failed to create webhook');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'webhooks.created',
        target_type: 'webhook',
        target_id: row.id,
        status: 'success',
        metadata: {
          name: row.name,
          description: row.description,
          endpoint: row.endpoint,
          filter: row.filter,
          tags: row.tags,
        },
      },
      tx,
    );

    return row;
  });

  const parsed = Schemas.createWebhook.response.parse(result);
  return parsed;
}

/**
 * Updates an existing webhook in the database.
 *
 * @param id
 * The ID of the webhook to update.
 *
 * @param request
 * The request object containing the updated webhook data.
 */
async function updateWebhook(
  id: string,
  request: UpdateWebhookBody,
): Promise<Result<UpdateWebhookResponse, UpdateWebhookFailure>> {
  const caller = getCaller();

  const result = await db.transaction(
    async (tx): Promise<Result<typeof webhooks.$inferSelect, UpdateWebhookFailure>> => {
      const [existing] = await tx
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.organization_id, caller.organization.id), eq(webhooks.id, id)))
        .for('update');

      // Either the webhook does not exist, or it belongs to someone else. Both
      // are the same refusal on purpose.
      if (!existing) {
        return err({ code: 'WEBHOOK_NOT_FOUND', id });
      }

      const writeableFields = Object.keys(Schemas.updateWebhook.body.shape);
      const { updates, difference } = diffFields(existing, request, writeableFields);

      if (Object.keys(difference).length === 0) {
        return ok(existing);
      }

      const [row] = await tx
        .update(webhooks)
        .set(updates)
        .where(and(eq(webhooks.organization_id, caller.organization.id), eq(webhooks.id, id)))
        .returning();

      if (!row) {
        throw new Error('Failed to update webhook');
      }

      await AuditLogServices.createAuditLog(
        {
          event: 'webhooks.updated',
          target_type: 'webhook',
          target_id: row.id,
          status: 'success',
          difference,
        },
        tx,
      );

      return ok(row);
    },
  );

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.updateWebhook.response.parse(result.value);
  return ok(parsed);
}

/**
 * Deletes an existing webhook in the database.
 *
 * @param id
 * The ID of the webhook to delete.
 */
async function deleteWebhook(id: string): Promise<Result<DeleteWebhookResponse, DeleteWebhookFailure>> {
  const caller = getCaller();

  return db.transaction(async (tx): Promise<Result<DeleteWebhookResponse, DeleteWebhookFailure>> => {
    const [row] = await tx
      .delete(webhooks)
      .where(and(eq(webhooks.organization_id, caller.organization.id), eq(webhooks.id, id)))
      .returning();

    if (!row) {
      return err({ code: 'WEBHOOK_NOT_FOUND', id });
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'webhooks.deleted',
        target_type: 'webhook',
        target_id: row.id,
        status: 'success',
        metadata: {
          name: row.name,
          description: row.description,
          endpoint: row.endpoint,
          filter: row.filter,
          tags: row.tags,
        },
      },
      tx,
    );

    return ok(undefined);
  });
}

// ---

/**
 * Retrieves queued deliveries.
 *
 * Scoped by joining through `webhooks`: the outbox has no organization of its
 * own, and giving it one would let the two disagree.
 */
async function listWebhookOutbox(request: ListWebhookOutboxQuery): Promise<ListWebhookOutboxResponse> {
  const caller = getCaller();

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    request.after_id ? lt(webhookOutbox.id, request.after_id) : undefined,
  ];

  const rows = await db
    .select({ outbox: webhookOutbox })
    .from(webhookOutbox)
    .innerJoin(webhooks, eq(webhooks.id, webhookOutbox.webhook_id))
    .where(and(...conditions))
    .orderBy(desc(webhookOutbox.id))
    .limit(request.limit + 1);

  const result = rows.map((row) => row.outbox);

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listWebhookOutbox.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Retrieves delivery attempts, scoped the same way as the outbox above.
 */
async function listWebhookDeliveries(request: ListWebhookDeliveriesQuery): Promise<ListWebhookDeliveriesResponse> {
  const caller = getCaller();

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    request.after_id ? lt(webhookDeliveries.id, request.after_id) : undefined,
  ];

  const rows = await db
    .select({ delivery: webhookDeliveries })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhook_id))
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.id))
    .limit(request.limit + 1);

  const result = rows.map((row) => row.delivery);

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listWebhookDeliveries.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Queues a delivery.
 *
 * Takes no organization: this is called by the pipeline that already resolved
 * the webhook, not by a request handler, and the webhook id it was given is
 * where the tenancy came from. Not a Result for the same reason - there is no
 * HTTP caller here to hand a refusal to.
 */
async function submitWebhookRequest(webhookId: string, logId: string) {
  const result = await db
    .insert(webhookOutbox)
    .values({
      webhook_id: webhookId,
      log_id: logId,
    })
    .returning();

  if (!result[0]) {
    throw new Error('Failed to submit webhook request');
  }

  return result[0];
}

/**
 * Queues webhooks whose filters match a completed log. Matching stays in
 * Postgres instead of loading and comparing filters in application code; null
 * and empty filters match every log. Failures are logged but do not turn a
 * completed inference into an error.
 *
 * @param organizationId
 * Tenant captured before a streaming continuation can outlive request context.
 *
 * @param logId
 * The log to deliver.
 *
 * @param tags
 * The log's tags, which the filters are matched against.
 */
async function fanOutForLog(
  organizationId: string,
  logId: string,
  tags: Record<string, string> | null | undefined,
): Promise<void> {
  const payload = JSON.stringify(tags ?? {});

  try {
    const matched = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.organization_id, organizationId),
          sql`(
            ${webhooks.filter} IS NULL
            OR ${webhooks.filter} = '{}'::jsonb
            OR ${payload}::jsonb @> ${webhooks.filter}
          )`,
        ),
      );

    if (matched.length === 0) {
      return;
    }

    await db.insert(webhookOutbox).values(matched.map((webhook) => ({ webhook_id: webhook.id, log_id: logId })));
  } catch (error) {
    getLogger().error({ err: error, log_id: logId }, 'Failed to fan out webhooks for log');
  }
}

/**
 * Queues an explicitly requested webhook delivery. The tenant-scoped lookup
 * prevents callers from routing their logs to another tenant's endpoint.
 *
 * @param webhookId
 * The webhook to notify.
 *
 * @param logId
 * The log to deliver. Carried without a foreign key - see the table.
 */
async function enqueueDelivery(webhookId: string, logId: string): Promise<Result<void, EnqueueDeliveryFailure>> {
  const caller = getCaller();

  const [webhook] = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.organization_id, caller.organization.id), eq(webhooks.id, webhookId)));

  if (!webhook) {
    return err({ code: 'WEBHOOK_NOT_FOUND', id: webhookId });
  }

  await db.insert(webhookOutbox).values({ webhook_id: webhookId, log_id: logId });

  return ok(undefined);
}

export default {
  enqueueDelivery,
  fanOutForLog,
  getWebhook,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,

  listWebhookOutbox,
  listWebhookDeliveries,

  submitWebhookRequest,
};
