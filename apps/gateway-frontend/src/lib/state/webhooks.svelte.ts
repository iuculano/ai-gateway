import type { Webhook, WebhookDelivery, WebhookOutboxEntry } from '#lib/api/types.ts';
import {
  type CreateWebhookInput,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhookOutbox,
  listWebhooks,
  type UpdateWebhookInput,
  updateWebhook,
} from '#lib/api/webhooks.ts';
import { AppendList } from '#lib/state/append-list.svelte.ts';

const PAGE_SIZE = 50;

/**
 * The webhooks page's data, which is the endpoints, the queue in front of them
 * and the attempts they produced.
 *
 * It is held here and not in the page because the three tables feed each
 * other. An endpoint's row reports its own pending and delivered counts, and
 * the other two tables name their endpoint through the endpoint list. Changes
 * go to the API first, and what is held here only changes once they have
 * succeeded.
 */
class WebhooksState {
  readonly endpoints = new AppendList<Webhook>(
    (after) => listWebhooks({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load webhooks.',
  );

  readonly outbox = new AppendList<WebhookOutboxEntry>(
    (after) => listWebhookOutbox({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load the outbox.',
  );

  readonly deliveries = new AppendList<WebhookDelivery>(
    (after) => listWebhookDeliveries({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load deliveries.',
  );

  /**
   * The endpoints by id, for the outbox and delivery tables, which carry an id
   * and nothing else. A miss is normal and not an error, because the endpoint
   * list is paged too and a delivery can name one that has not been paged in.
   */
  readonly byId = $derived(new Map(this.endpoints.rows.map((webhook) => [webhook.id, webhook])));

  /**
   * Fetches all three lists once.
   */
  async ensureLoaded(): Promise<void> {
    await Promise.all([this.endpoints.ensureLoaded(), this.outbox.ensureLoaded(), this.deliveries.ensureLoaded()]);
  }

  /**
   * Reads all three again from the top.
   */
  async refresh(): Promise<void> {
    // All three, even with one table on show. The outbox drains into the
    // deliveries, so reading either alone shows a queue and a history that
    // disagree about work already done.
    await Promise.all([this.endpoints.load(), this.outbox.load(), this.deliveries.load()]);
  }

  async create(input: CreateWebhookInput): Promise<Webhook> {
    const created = await createWebhook(input);

    this.endpoints.rows = [created, ...this.endpoints.rows];

    return created;
  }

  async update(id: string, input: UpdateWebhookInput): Promise<Webhook> {
    const updated = await updateWebhook(id, input);

    this.endpoints.rows = this.endpoints.rows.map((webhook) => (webhook.id === id ? updated : webhook));

    return updated;
  }

  /**
   * Deletes an endpoint, and with it everything queued or recorded against it.
   */
  async remove(id: string): Promise<void> {
    await deleteWebhook(id);

    // The queued and delivered rows go too, because the database deletes them
    // along with the endpoint. Left on show, the queue would hold work for an
    // endpoint that no longer exists.
    this.endpoints.rows = this.endpoints.rows.filter((webhook) => webhook.id !== id);
    this.outbox.rows = this.outbox.rows.filter((entry) => entry.webhook_id !== id);
    this.deliveries.rows = this.deliveries.rows.filter((delivery) => delivery.webhook_id !== id);
  }
}

export const webhooks = new WebhooksState();
