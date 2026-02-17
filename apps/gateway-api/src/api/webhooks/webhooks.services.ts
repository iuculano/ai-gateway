import { HTTPException } from 'hono/http-exception';
import { db, and, eq, desc, lt, sql } from '@repo/drizzle';
import { webhooks, webhookOutbox, webhookDeliveries } from '@repo/drizzle/schemas';
import Schemas, {
  type GetWebhookResponse,
  type ListWebhooksResponse,
  type CreateWebhookResponse,
  type UpdateWebhookResponse,
  type DeleteWebhookResponse,
  type CreateWebhookBody,
  type UpdateWebhookBody,
  type ListWebhooksQuery,
  type ListWebhookOutboxResponse,
  type ListWebhookOutboxQuery,
  type ListWebhookDeliveriesQuery,
  type ListWebhookDeliveriesResponse,
} from './webhooks.schemas';
import { parseTags } from '@repo/core';


/**
 * Retrieves a single webhook by its ID.
 *
 * @param id
 * The ID of the webhook to retrieve.
 *
 * @returns
 * A promise that resolves to the webhook data.
 */
async function getWebhook(id: string) : Promise<GetWebhookResponse> {
  const result = await db.select()
    .from(webhooks)
    .where(eq(webhooks.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getWebhook.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a list of webhooks, filtered by the given criteria.
 *
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the webhook data.
 */
async function listWebhooks(request: ListWebhooksQuery) : Promise<ListWebhooksResponse> {
  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    request.tags      ? sql`${webhooks.tags} @> ${tagsToFilter}::jsonb` : undefined,
    request.after_id  ? lt(webhooks.id, request.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(webhooks)
    .where(whereClause)
    .orderBy(desc(webhooks.id))
    .limit(request.limit + 1);

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
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
 * @param request
 * The request object containing the model data to create.
 *
 * @returns
 * A promise that resolves to the created webhook data.
 */
async function createWebhook(request: CreateWebhookBody) : Promise<CreateWebhookResponse> {
  const result = await db.insert(webhooks)
    .values(request)
    .returning();

  if (!result[0]) {
    throw new HTTPException(500, {
      message: 'Failed to create webhook',
    });
  }

  const parsed = Schemas.createWebhook.response.parse(result[0]);
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
 *
 * @returns
 * A promise that resolves to the updated webhook data.
 */
async function updateWebhook(id: string, request: UpdateWebhookBody) : Promise<UpdateWebhookResponse> {
  const result = await db.update(webhooks)
    .set(request)
    .where(eq(webhooks.id, id))
    .returning();

  // Almost guaranteed that the webhook doesn't exist.
  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.updateWebhook.response.parse(result[0]);
  return parsed;
}

/**
 * Deletes an existing webhook in the database.
 *
 * @param id
 * The ID of the webhook to delete.
 *
 * @returns
 * A promise that resolves to the deleted webhook data.
 */
async function deleteWebhook(id: string) : Promise<DeleteWebhookResponse> {
  const result = await db.delete(webhooks)
    .where(eq(webhooks.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }
}

// ---

async function listWebhookOutbox(request: ListWebhookOutboxQuery) : Promise<ListWebhookOutboxResponse> {
  const conditions = [
    request.after_id  ? lt(webhookOutbox.id, request.after_id) : undefined,
  ];

  const result = await db.select()
    .from(webhookOutbox)
    .where(and(...conditions))
    .orderBy(desc(webhookOutbox.id))
    .limit(request.limit + 1);

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

async function listWebhookDeliveries(request: ListWebhookDeliveriesQuery) : Promise<ListWebhookDeliveriesResponse> {
  const conditions = [
    request.after_id  ? lt(webhookDeliveries.id, request.after_id) : undefined,
  ];

  const result = await db.select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.id))
    .limit(request.limit + 1);

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

async function submitWebhookRequest(webhookId: string, logId: string) {
  const result = await db.insert(webhookOutbox)
    .values({
      webhook_id: webhookId,
      log_id: logId,
    })
    .returning();

  if (!result[0]) {
    throw new HTTPException(500, {
      message: 'Failed to submit webhook request',
    });
  }

  return result[0];
}

export default {
  getWebhook,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,

  listWebhookOutbox,
  listWebhookDeliveries,

  submitWebhookRequest,
}
