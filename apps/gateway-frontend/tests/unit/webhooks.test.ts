import { expect, test } from 'bun:test';
import {
  buildActivity,
  deliveryOutcome,
  EMPTY_ACTIVITY,
  endpointProblem,
  searchDeliveries,
  searchEndpoints,
  searchOutbox,
} from '../../src/lib/data/webhooks';

// A status code from each class the worker can record, and whether it counts.
const OUTCOMES = [
  { status: 0, label: 'No response', ok: false },
  { status: 204, label: 'Delivered', ok: true },
  { status: 302, label: 'Unexpected', ok: false },
  { status: 404, label: 'Rejected', ok: false },
  { status: 503, label: 'Server error', ok: false },
];

type Delivery = Parameters<typeof buildActivity>[1][number];

function delivery(webhook_id: string, status_code: number, created_at: string): Delivery {
  return { webhook_id: webhook_id, status_code: status_code, created_at: created_at };
}

// deliveryOutcome

test('only a 2xx counts as delivered', () => {
  for (const { status, label, ok } of OUTCOMES) {
    expect(deliveryOutcome(status)).toMatchObject({ label: label, ok: ok });
  }
});

// buildActivity

test('each endpoint gets its own counts and its latest attempt', () => {
  const outbox = [{ webhook_id: 'billing' }, { webhook_id: 'billing' }];

  // Newest first, which is the order the API returns them in.
  const deliveries = [
    delivery('billing', 500, '2026-10-03T12:00:00.000Z'),
    delivery('billing', 200, '2026-10-03T11:00:00.000Z'),
    delivery('audit', 200, '2026-10-03T10:00:00.000Z'),
  ];

  const activity = buildActivity(outbox, deliveries);

  expect(activity.get('billing')).toEqual({
    pending: 2,
    delivered: 1,
    failed: 1,
    lastAttemptAt: '2026-10-03T12:00:00.000Z',
  });
  expect(activity.get('audit')).toEqual({
    pending: 0,
    delivered: 1,
    failed: 0,
    lastAttemptAt: '2026-10-03T10:00:00.000Z',
  });
});

test('counting leaves the shared empty value empty', () => {
  // Every endpoint with no traffic is handed this one object, so counting into
  // it would credit one endpoint's traffic to all of them.
  buildActivity([{ webhook_id: 'billing' }], [delivery('billing', 200, '2026-10-03T12:00:00.000Z')]);

  expect(EMPTY_ACTIVITY).toEqual({ pending: 0, delivered: 0, failed: 0, lastAttemptAt: null });
});

test('an endpoint has to be a whole web address', () => {
  expect(endpointProblem('https://example.test/hooks')).toBeNull();
  expect(endpointProblem('http://localhost:3000/hooks')).toBeNull();

  expect(endpointProblem('example.test/hooks')).toBe('Enter a full URL, including https://.');
  expect(endpointProblem('ftp://example.test/hooks')).toBe('The endpoint must be an http:// or https:// URL.');
});

// Search

const BILLING = {
  id: 'wh-billing',
  name: 'Billing sink',
  description: 'Invoices for finance',
  endpoint: 'https://hooks.example.com/billing',
  tags: { team: 'payments' },
  filter: { env: 'prod' },
};

const ALERTS = {
  id: 'wh-alerts',
  name: 'Pager',
  description: null,
  endpoint: 'https://alerts.example.net/in',
  tags: null,
  filter: null,
};

const ENDPOINTS = new Map([BILLING, ALERTS].map((webhook) => [webhook.id, webhook]));

test.each([
  ['its name', 'pager', ['wh-alerts']],
  ['its description', 'finance', ['wh-billing']],
  ['its address', 'example.net', ['wh-alerts']],
  ['a tag', 'team=payments', ['wh-billing']],
  ['its filter', 'env=prod', ['wh-billing']],
  ['nothing typed', '', ['wh-billing', 'wh-alerts']],
])('an endpoint is found by %s', (_what, query, found) => {
  expect(searchEndpoints([BILLING, ALERTS], query).map((webhook) => webhook.id)).toEqual(found);
});

test('a queued row is found by the name of its endpoint, which it does not carry', () => {
  const outbox = [
    { log_id: 'log-1', webhook_id: 'wh-billing' },
    { log_id: 'log-2', webhook_id: 'wh-alerts' },
    { log_id: 'log-3', webhook_id: 'wh-gone' },
  ];

  expect(searchOutbox(outbox, 'pager', ENDPOINTS).map((entry) => entry.log_id)).toEqual(['log-2']);
  expect(searchOutbox(outbox, 'log-3', ENDPOINTS).map((entry) => entry.log_id)).toEqual(['log-3']);
});

test('a delivery is found by what became of it, and by where it went', () => {
  const deliveries = [
    { id: 'ok', status_code: 204, webhook_id: 'wh-billing' },
    { id: 'refused', status_code: 404, webhook_id: 'wh-alerts' },
    { id: 'orphan', status_code: 503, webhook_id: 'wh-gone' },
  ];

  expect(searchDeliveries(deliveries, 'rejected', ENDPOINTS).map((delivery) => delivery.id)).toEqual(['refused']);
  expect(searchDeliveries(deliveries, 'hooks.example.com', ENDPOINTS).map((delivery) => delivery.id)).toEqual(['ok']);
  expect(searchDeliveries(deliveries, '503', ENDPOINTS).map((delivery) => delivery.id)).toEqual(['orphan']);
});
