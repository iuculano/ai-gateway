import { logger } from '@repo/core';
import { db, eq, inArray } from '@repo/drizzle';
import { webhookDeliveries, webhookOutbox, webhooks } from '@repo/drizzle/schemas';
import { environment } from '../environment';

/**
 * Recorded as the status when there was no HTTP response at all - DNS failure,
 * connection refused, or the delivery timing out.
 *
 * A sentinel rather than a null because `status_code` is NOT NULL, and a
 * delivery row has to exist either way: the history is the only evidence the
 * attempt happened, and omitting the ones that failed hardest would make the
 * table lie by silence.
 */
const NO_RESPONSE = 0;

interface ClaimedDelivery {
  outboxId: string;
  webhookId: string;
  endpoint: string;
  logId: string;
}

/**
 * Takes a batch off the queue, and hands ownership of it to this process.
 *
 * The rows are deleted as they are claimed, inside the same short transaction
 * that selects them, so nothing is held while the HTTP calls happen. That is a
 * deliberate at-most-once trade: a crash mid-batch loses those notifications.
 *
 * The alternative it replaces was worse. Delivery used to run INSIDE the
 * claiming transaction, so one endpoint refusing a connection threw, rolled the
 * whole batch back, and left it to be reclaimed on the next tick - forever, for
 * every webhook behind it. One bad endpoint stopped the entire queue.
 *
 * Rows are joined to `webhooks` rather than to `logs`. The log is not read here
 * - only its id is sent - and joining it meant a pruned log stranded its outbox
 * row permanently, since the inner join could never match again.
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
      .for('update', { skipLocked: true }); // skip already locked rows, otherwise multiple workers will block

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

      // Without this a hanging endpoint hangs the worker: the tick never
      // finishes, and with the drain now outside a transaction there is nothing
      // else to time it out.
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
    // The attempt happened whatever this says; losing the record of it is bad
    // but not worth failing the tick over.
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

  // Should this be concurrent?
  for (const item of batch) {
    await deliver(item);
  }
}
