import type { InferRequestType } from 'hono/client';
import { client } from './client';

type WebhooksClient = (typeof client)['webhooks'];
type WebhookClient = WebhooksClient[':id'];

export type CreateWebhookInput = InferRequestType<WebhooksClient['$post']>['json'];
export type UpdateWebhookInput = InferRequestType<WebhookClient['$patch']>['json'];

export type ListWebhooksQuery = NonNullable<InferRequestType<WebhooksClient['$get']>['query']>;
export type ListWebhookOutboxQuery = NonNullable<InferRequestType<WebhooksClient['outbox']['$get']>['query']>;
export type ListWebhookDeliveriesQuery = NonNullable<InferRequestType<WebhooksClient['deliveries']['$get']>['query']>;

export async function listWebhooks(query: ListWebhooksQuery = {}) {
  const response = await client.webhooks.$get({ query });
  return response.json();
}

export async function getWebhook(id: string) {
  const response = await client.webhooks[':id'].$get({ param: { id } });
  return response.json();
}

export async function createWebhook(input: CreateWebhookInput) {
  const response = await client.webhooks.$post({ json: input });
  return response.json();
}

export async function updateWebhook(id: string, input: UpdateWebhookInput) {
  const response = await client.webhooks[':id'].$patch({ param: { id }, json: input });
  return response.json();
}

export async function deleteWebhook(id: string): Promise<void> {
  await client.webhooks[':id'].$delete({ param: { id } });
}

/**
 * Deliveries still queued, newest first.
 *
 * Org-wide rather than per-webhook: the endpoint takes no webhook_id, so a
 * per-endpoint figure has to be counted client-side out of the window this
 * returns. Rows leave this list for good once the worker drains them.
 */
export async function listWebhookOutbox(query: ListWebhookOutboxQuery = {}) {
  const response = await client.webhooks.outbox.$get({ query });
  return response.json();
}

/**
 * Delivery attempts, newest first.
 *
 * The history the outbox leaves behind - one row per attempt, carrying the
 * status code the endpoint answered with, kept after the queued row is gone.
 * Also org-wide.
 */
export async function listWebhookDeliveries(query: ListWebhookDeliveriesQuery = {}) {
  const response = await client.webhooks.deliveries.$get({ query });
  return response.json();
}
