import { diffFields, parseTags, probe, toPage } from '@repo/core';
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
 * The underlying error definitions.
 */
type WebhookNotFoundFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

/**
 * The public service failure unions.
 */
export type EnqueueDeliveryFailure = WebhookNotFoundFailure;
export type GetWebhookFailure = WebhookNotFoundFailure;
export type UpdateWebhookFailure = WebhookNotFoundFailure;
export type DeleteWebhookFailure = WebhookNotFoundFailure;

/**
 * Retrieves a single webhook by its ID.
 *
 * @param id
 * The ID of the webhook to retrieve.
 */
async function getWebhook(id: string): Promise<Result<GetWebhookResponse, GetWebhookFailure>> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(
      eq(webhooks.organization_id, caller.organization.id),
      eq(webhooks.id, id)
    ));

  if (!row) {
    return err({ code: 'WEBHOOK_NOT_FOUND', id });
  }

  const parsed = Schemas.getWebhook.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a list of webhooks, filtered by the given criteria.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listWebhooks(query: ListWebhooksQuery): Promise<ListWebhooksResponse> {
  const caller = getCaller();
  const tagsToFilter = parseTags(query.tags);

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    query.tags ? sql`${webhooks.tags} @> ${tagsToFilter}::jsonb` : undefined,
    query.after_id ? lt(webhooks.id, query.after_id) : undefined,
  ];

    // biome-ignore format: looks nicer
  const rows = await db
    .select()
    .from(webhooks)
    .where(and(...conditions))
    .orderBy(desc(webhooks.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);
  const parsed = Schemas.listWebhooks.response.parse(page);

  return parsed;
}

/**
 * Creates a new webhook.
 *
 * @param body
 * The request object containing the webhook data to create.
 */
async function createWebhook(body: CreateWebhookBody): Promise<CreateWebhookResponse> {
  const caller = getCaller();

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhooks)
      .values({
        ...body,
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
    // biome-ignore format: looks nicer
    const [row] = await tx
      .delete(webhooks)
      .where(and(
        eq(webhooks.organization_id, caller.organization.id),
        eq(webhooks.id, id)
      ))
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

/**
 * Retrieves queued deliveries.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listWebhookOutbox(query: ListWebhookOutboxQuery): Promise<ListWebhookOutboxResponse> {
  const caller = getCaller();

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    query.after_id ? lt(webhookOutbox.id, query.after_id) : undefined,
  ];

  const rows = await db
    .select({ outbox: webhookOutbox })
    .from(webhookOutbox)
    .innerJoin(webhooks, eq(webhooks.id, webhookOutbox.webhook_id))
    .where(and(...conditions))
    .orderBy(desc(webhookOutbox.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit, (row) => row.outbox.id);

  const parsed = Schemas.listWebhookOutbox.response.parse({
    data: page.data.map((row) => row.outbox),
    meta: page.meta,
  });

  return parsed;
}

/**
 * Retrieves delivery attempts.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listWebhookDeliveries(query: ListWebhookDeliveriesQuery): Promise<ListWebhookDeliveriesResponse> {
  const caller = getCaller();

  const conditions = [
    eq(webhooks.organization_id, caller.organization.id),
    query.after_id ? lt(webhookDeliveries.id, query.after_id) : undefined,
  ];

  const rows = await db
    .select({ delivery: webhookDeliveries })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhook_id))
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit, (row) => row.delivery.id);

  const parsed = Schemas.listWebhookDeliveries.response.parse({
    data: page.data.map((row) => row.delivery),
    meta: page.meta,
  });

  return parsed;
}

/**
 * Queues a delivery.
 *
 * @param webhookId
 * The id of the webhook to notify.
 *
 * @param logId
 * The id of the log to deliver.
 */
async function submitWebhookRequest(webhookId: string, logId: string) {
  // biome-ignore format: looks nicer
  const [result] = await db
    .insert(webhookOutbox)
    .values({
      webhook_id: webhookId,
      log_id: logId,
    })
    .returning();

  if (!result) {
    throw new Error('Failed to submit webhook request');
  }

  return result;
}

/**
 * Queues webhooks whose filters match a completed log.
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
 * Queues an explicitly requested webhook delivery.
 *
 * @param webhookId
 * The id of the webhook to notify.
 *
 * @param logId
 * The id of the log to deliver.
 */
async function enqueueDelivery(webhookId: string, logId: string): Promise<Result<void, EnqueueDeliveryFailure>> {
  const caller = getCaller();

  // Make sure this tenant actually owns the webhook first.
  // biome-ignore format: looks nicer
  const [webhook] = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(
      eq(webhooks.organization_id, caller.organization.id),
      eq(webhooks.id, webhookId)
    ));

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
