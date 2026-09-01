import type { Webhook, WebhookDelivery, WebhookOutboxEntry } from '$lib/api/types';
import {
  type CreateWebhookInput,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhookOutbox,
  listWebhooks,
  type UpdateWebhookInput,
  updateWebhook,
} from '$lib/api/webhooks';
import { CursorList } from './cursor-list.svelte';

const PAGE_SIZE = 50;

/**
 * The webhooks page's data: the endpoints themselves, the queue in front of
 * them, and the attempts they produced.
 *
 * Held in a store rather than in the page component because all three tables
 * feed each other - an endpoint row reports its own pending and delivered
 * counts, and the outbox and delivery tables resolve their `webhook_id` to a
 * name through the endpoint list. Mutations go to the API first; local state
 * only changes on success.
 */
class WebhooksState {
  readonly endpoints = new CursorList<Webhook>(
    (after) => listWebhooks({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load webhooks.',
  );

  readonly outbox = new CursorList<WebhookOutboxEntry>(
    (after) => listWebhookOutbox({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load the outbox.',
  );

  readonly deliveries = new CursorList<WebhookDelivery>(
    (after) => listWebhookDeliveries({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load deliveries.',
  );

  /**
   * Endpoint lookup for the outbox and delivery tables, which carry a
   * `webhook_id` and nothing else - there is no join on those endpoints.
   *
   * A miss is normal rather than an error: the endpoint list is paginated too,
   * so a delivery can name a webhook that is real but has not been paged in.
   */
  readonly byId = $derived(new Map(this.endpoints.rows.map((webhook) => [webhook.id, webhook])));

  /** Fetches all three lists once. */
  async ensureLoaded(): Promise<void> {
    await Promise.all([this.endpoints.ensureLoaded(), this.outbox.ensureLoaded(), this.deliveries.ensureLoaded()]);
  }

  /**
   * Re-reads all three from the top.
   *
   * All three together even when one table is on screen: the outbox drains into
   * the deliveries list, so refreshing either alone shows a queue and a history
   * that disagree about work the worker has already done.
   */
  async refresh(): Promise<void> {
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
   *
   * The queued and delivered rows are dropped locally because the database drops
   * them too - both tables reference `webhooks.id` with `onDelete: 'cascade'`.
   * Leaving them on screen would show a queue holding work for an endpoint that
   * no longer exists.
   */
  async remove(id: string): Promise<void> {
    await deleteWebhook(id);

    this.endpoints.rows = this.endpoints.rows.filter((webhook) => webhook.id !== id);
    this.outbox.rows = this.outbox.rows.filter((entry) => entry.webhook_id !== id);
    this.deliveries.rows = this.deliveries.rows.filter((delivery) => delivery.webhook_id !== id);
  }
}

export const webhooks = new WebhooksState();
