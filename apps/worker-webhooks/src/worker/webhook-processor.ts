import { logger } from '@repo/core';
import { db, eq, inArray } from '@repo/drizzle';
import { webhookDeliveries, webhookOutbox, webhooks } from '@repo/drizzle/schemas';
import { environment } from '../environment';

/**
 * Sentinel for transport failures where no HTTP status exists. Delivery rows
 * still record these attempts because `status_code` is required.
 */
const NO_RESPONSE = 0;

interface ClaimedDelivery {
  outboxId: string;
  webhookId: string;
  endpoint: string;
  logId: string;
}

/**
 * Claims and deletes a batch in one short transaction so HTTP calls hold no
 * database locks.
 *
 * This is currently at-most-once - a crash after claiming loses the batch,
 * but one failed endpoint cannot block the queue. Logs are not joined because
 * delivery only needs their ids and pruned logs must not strand outbox rows.
 *
 * TODO: FIX ME.
 */
async function claimBatch(): Promise<ClaimedDelivery[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        outboxId: webhookOutbox.id,
        webhookId: webhooks.id,
        endpoint: webhooks.endpoint,
        logId: webhookOutbox.log_id,
      })
      .from(webhookOutbox)
      .innerJoin(webhooks, eq(webhookOutbox.webhook_id, webhooks.id))
      .orderBy(webhookOutbox.created_at)
      .limit(environment.WORKER_BATCH_SIZE)
      .for('update', { skipLocked: true }); // Let replicas claim disjoint batches.

    if (rows.length === 0) {
      return [];
    }

    await tx.delete(webhookOutbox).where(
      inArray(
        webhookOutbox.id,
        rows.map((row) => row.outboxId),
      ),
    );

    return rows;
  });
}

/**
 * POSTs one claimed row and records what came back.
 *
 * Never throws. A delivery that fails is one delivery that failed, and letting
 * it escape would take the rest of the batch with it.
 */
async function deliver(item: ClaimedDelivery): Promise<void> {
  let statusCode = NO_RESPONSE;

  try {
    const response = await fetch(item.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_id: item.webhookId, log_id: item.logId }),

      // Try to avoid stalling the worker on a slow endpoint.
      signal: AbortSignal.timeout(environment.WORKER_DELIVERY_TIMEOUT_MS),
    });

    statusCode = response.status;

    if (response.ok) {
      logger.debug({ webhook_id: item.webhookId, log_id: item.logId }, 'Delivered webhook');
    } else {
      logger.warn(
        { webhook_id: item.webhookId, log_id: item.logId, status_code: statusCode },
        'Webhook endpoint rejected the delivery',
      );
    }
  } catch (error) {
    logger.warn({ err: error, webhook_id: item.webhookId, log_id: item.logId }, 'Webhook delivery could not be made');
  }

  try {
    await db.insert(webhookDeliveries).values({
      outbox_id: item.outboxId,
      webhook_id: item.webhookId,
      status_code: statusCode,
    });
  } catch (error) {
    // Recording failure should not prevent the remaining deliveries.
    logger.error({ err: error, webhook_id: item.webhookId }, 'Failed to record a webhook delivery');
  }
}

/**
 * Drains one batch of the outbox.
 */
export async function tickWebhookProcessor(): Promise<void> {
  const batch = await claimBatch();

  if (batch.length === 0) {
    return;
  }

  logger.debug({ count: batch.length }, 'Claimed a webhook batch');

  for (const item of batch) {
    await deliver(item);
  }
}
