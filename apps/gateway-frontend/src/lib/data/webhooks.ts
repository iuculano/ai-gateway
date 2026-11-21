import { pairSummary } from '#lib/data/format.ts';

export interface DeliveryOutcome {
  label: string;
  color: string;

  /**
   * True only for a 2xx, which is what the worker itself treats as delivered.
   */
  ok: boolean;
}

/**
 * What a recorded status code means, in the worker's own terms.
 *
 * The worker writes a delivery row for every attempt and takes `response.ok`
 * as success, so a 2xx is delivered and nothing else is. 4xx and 5xx are kept
 * apart because they point at different things to fix. One is the endpoint
 * refusing the payload and the other is the endpoint falling over. Neither is
 * retried today, so both are final.
 */
export function deliveryOutcome(statusCode: number): DeliveryOutcome {
  // The worker records 0 for an attempt that produced no HTTP response at all,
  // such as a DNS failure, a refused connection or a timeout. The attempt
  // happened, and a history that left out the hardest failures would mislead
  // by saying nothing.
  if (statusCode === 0) {
    return { label: 'No response', color: '#f87171', ok: false };
  }

  if (statusCode >= 200 && statusCode < 300) {
    return { label: 'Delivered', color: '#10b981', ok: true };
  }

  if (statusCode >= 500) {
    return { label: 'Server error', color: '#f87171', ok: false };
  }

  if (statusCode >= 400) {
    return { label: 'Rejected', color: '#f59e0b', ok: false };
  }

  // 1xx and 3xx. fetch follows redirects, so nothing here is an answer the
  // endpoint meant to give, and it is named for what it is.
  return { label: 'Unexpected', color: '#a1a1aa', ok: false };
}

export interface WebhookActivity {
  /**
   * Rows still queued for this endpoint.
   */
  pending: number;
  delivered: number;
  failed: number;

  /**
   * The most recent attempt, or null if none is in the loaded window.
   */
  lastAttemptAt: string | null;
}

/**
 * The counters for an endpoint that has neither queued nor delivered anything.
 *
 * Frozen because it is handed to every row that buildActivity found nothing
 * for, so a single `+= 1` against it would credit one endpoint's traffic to all
 * of them. The builder spreads it and never counts into it.
 */
export const EMPTY_ACTIVITY: WebhookActivity = Object.freeze({
  pending: 0,
  delivered: 0,
  failed: 0,
  lastAttemptAt: null,
});

function activityOf(activity: Map<string, WebhookActivity>, webhookId: string): WebhookActivity {
  let entry = activity.get(webhookId);

  if (!entry) {
    entry = { ...EMPTY_ACTIVITY };
    activity.set(webhookId, entry);
  }

  return entry;
}

/**
 * The counters for each endpoint, built in one pass over the loaded outbox and
 * deliveries.
 *
 * They are worked out here because neither list takes a `webhook_id` or
 * returns a total. So they count the rows that are paged in and not the whole
 * table, and every caption that shows them says so.
 */
export function buildActivity(
  outbox: { webhook_id: string }[],
  deliveries: { webhook_id: string; status_code: number; created_at: string }[],
): Map<string, WebhookActivity> {
  const activity = new Map<string, WebhookActivity>();

  for (const entry of outbox) {
    activityOf(activity, entry.webhook_id).pending += 1;
  }

  for (const delivery of deliveries) {
    const entry = activityOf(activity, delivery.webhook_id);

    if (deliveryOutcome(delivery.status_code).ok) {
      entry.delivered += 1;
    } else {
      entry.failed += 1;
    }

    // Deliveries arrive newest first, so the first one seen for an endpoint is
    // its latest attempt.
    entry.lastAttemptAt ??= delivery.created_at;
  }

  return activity;
}

/**
 * What is wrong with an endpoint as typed, as a sentence for the reader, or
 * null when it can be saved.
 */
export function endpointProblem(endpoint: string): string | null {
  // The API takes the endpoint as a bare string, so nothing after this refuses
  // a typo. The worker would post to it and record whatever failure came back.
  const url = URL.parse(endpoint);

  if (!url) {
    return 'Enter a full URL, including https://.';
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The endpoint must be an http:// or https:// URL.';
  }

  return null;
}

interface SearchedEndpoint {
  name: string;
  description: string | null;
  endpoint: string;
  tags?: Record<string, string> | null;
  filter?: Record<string, string> | null;
}

/**
 * The endpoints a search finds, by name, description, address, tags or filter.
 *
 * @param query
 * What was typed, trimmed and in lower case. Empty finds everything.
 */
export function searchEndpoints<T extends SearchedEndpoint>(endpoints: T[], query: string): T[] {
  return endpoints.filter((webhook) =>
    `${webhook.name} ${webhook.description ?? ''} ${webhook.endpoint} ${pairSummary(webhook.tags)} ${pairSummary(webhook.filter)}`
      .toLowerCase()
      .includes(query),
  );
}

/**
 * The queued rows a search finds. A row carries ids and nothing else, so the
 * search also covers the name of the endpoint it is queued for. Matching the
 * raw ids alone would leave the search box with nothing a person would type.
 *
 * @param byId
 * The endpoints that are loaded, to read the names from.
 */
export function searchOutbox<T extends { log_id: string; webhook_id: string }>(
  entries: T[],
  query: string,
  byId: Map<string, { name: string }>,
): T[] {
  return entries.filter((entry) =>
    `${entry.log_id} ${entry.webhook_id} ${byId.get(entry.webhook_id)?.name ?? ''}`.toLowerCase().includes(query),
  );
}

/**
 * The delivery attempts a search finds, by status code, by what became of
 * them, or by the name or address of the endpoint they went to.
 */
export function searchDeliveries<T extends { status_code: number; webhook_id: string }>(
  deliveries: T[],
  query: string,
  byId: Map<string, { name: string; endpoint: string }>,
): T[] {
  return deliveries.filter((delivery) => {
    const webhook = byId.get(delivery.webhook_id);
    const outcome = deliveryOutcome(delivery.status_code);

    return `${delivery.status_code} ${outcome.label} ${delivery.webhook_id} ${webhook?.name ?? ''} ${webhook?.endpoint ?? ''}`
      .toLowerCase()
      .includes(query);
  });
}
