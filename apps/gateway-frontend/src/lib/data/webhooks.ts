export interface DeliveryOutcome {
  label: string;
  color: string;
  /** True only for a 2xx - what the worker itself treats as delivered. */
  ok: boolean;
}

/**
 * What a recorded status code means, in the worker's own terms.
 *
 * The worker writes a delivery row for every attempt and calls `response.ok`
 * the success line, so 2xx is delivered and everything else is not. 4xx and 5xx
 * are split apart because they point at different things to go and fix - the
 * endpoint refused the payload, versus the endpoint fell over - and neither is
 * retried today, so both are final.
 */
export function deliveryOutcome(statusCode: number): DeliveryOutcome {
  // The worker's sentinel for an attempt that produced no HTTP response at all
  // - DNS failure, connection refused, or a timeout. status_code is NOT NULL,
  // so it records 0 rather than skipping the row: the attempt happened, and a
  // history that omitted the hardest failures would mislead by silence.
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

  // 1xx and 3xx: fetch follows redirects, so nothing here is an answer the
  // endpoint meant to give. Named for what it is rather than guessed at.
  return { label: 'Unexpected', color: '#a1a1aa', ok: false };
}

export interface WebhookActivity {
  /** Rows still queued for this endpoint. */
  pending: number;
  delivered: number;
  failed: number;
  /** The most recent attempt, or null if none is in the loaded window. */
  lastAttemptAt: string | null;
}

/**
 * The counters for an endpoint that has neither queued nor delivered anything.
 *
 * Frozen because it is handed to every row that buildActivity found nothing for,
 * so a single `+= 1` against it would credit one endpoint's traffic to all of
 * them. The builder spreads it rather than counting into it.
 */
export const EMPTY_ACTIVITY: WebhookActivity = Object.freeze({
  pending: 0,
  delivered: 0,
  failed: 0,
  lastAttemptAt: null,
});

/**
 * Per-endpoint counters, built in one pass over the loaded outbox and deliveries.
 *
 * Client-side because neither endpoint takes a `webhook_id` and neither returns
 * an aggregate - so these are counts over the rows currently paged in, not over
 * the table, and every caption that shows them says so. The alternative was a
 * filter per row against both arrays, which is the same numbers computed once
 * per endpoint per render.
 */
export function buildActivity(
  outbox: { webhook_id: string }[],
  deliveries: { webhook_id: string; status_code: number; created_at: string }[],
): Map<string, WebhookActivity> {
  const activity = new Map<string, WebhookActivity>();

  const entryFor = (webhookId: string): WebhookActivity => {
    const existing = activity.get(webhookId);
    if (existing) return existing;

    const created = { ...EMPTY_ACTIVITY };
    activity.set(webhookId, created);
    return created;
  };

  for (const entry of outbox) {
    entryFor(entry.webhook_id).pending += 1;
  }

  for (const delivery of deliveries) {
    const entry = entryFor(delivery.webhook_id);

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
