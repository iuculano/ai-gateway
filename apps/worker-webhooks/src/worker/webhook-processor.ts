// This is cursed, need to fix
import { db, eq } from '@repo/drizzle';
import { logs, webhookDeliveries, webhookOutbox, webhooks } from '@repo/drizzle/schemas';
import { environment } from '../environment';

export async function tickWebhookProcessor(): Promise<void> {
  // Need to lock the rows we're pulling in case this ticks again while we're
  // processing the batch.
  await db.transaction(async (tx) => {
    const result = await tx
      .select()
      .from(webhookOutbox)
      .innerJoin(webhooks, eq(webhookOutbox.webhook_id, webhooks.id))
      .innerJoin(logs, eq(webhookOutbox.log_id, logs.id))
      .orderBy(webhookOutbox.created_at)
      .limit(environment.WORKER_BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (result && result.length === 0) {
      return;
    }

    // TODO split this out later, we're basically just doing work in this
    // transaction and holding it longer than we need to.
    const unprocessable: (typeof result)[0][] = [];

    for (const item of result) {
      if (!item.logs || !item.webhooks) {
        unprocessable.push(item);
        continue;
      }

      if (item.logs.tags && item.webhooks.filter) {
        // Tag matching for the filter.
        for (const [k, v] of Object.entries(item.webhooks.filter)) {
          if (!(k in item.logs.tags) || item.logs.tags[k] !== v) {
            unprocessable.push(item);
          }
        }
      }

      const response = await fetch(item.webhooks.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook_id: item.webhooks.id,
          log_id: item.logs.id,
        }),
      });

      if (response.ok) {
        console.info(`Ssuccessfully delivered webhook ${item.webhooks.id} for log ${item.logs.id}`);
      }

      await tx.insert(webhookDeliveries).values({
        outbox_id: item.webhook_outbox.id,
        webhook_id: item.webhooks.id,
        status_code: response.status,
      });

      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, item.webhook_outbox.id));

      if (!response.ok) {
        console.info(`Failed to deliver webhook ${item.webhooks.id} for log ${item.logs.id}`);
        unprocessable.push(item);
      }
    }
  });
}
