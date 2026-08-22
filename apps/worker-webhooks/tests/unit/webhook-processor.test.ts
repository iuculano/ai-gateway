import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createDatabaseDouble, failsWith, rows } from '@repo/test-helpers';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';

const { database, db } = createDatabaseDouble();
const actualDrizzle = await import('@repo/drizzle');

mock.module('@repo/drizzle', () => ({ ...actualDrizzle, db }));

const { tickWebhookProcessor } = await import('../../src/worker/webhook-processor');

const originalFetch = globalThis.fetch;
const WEBHOOK_ID = '01912d3f-9b4a-7c3d-8e2f-000000000005';
const OUTBOX_ID = '01912d3f-9b4a-7c3d-8e2f-000000000006';
const LOG_ID = '01912d3f-9b4a-7c3d-8e2f-000000000007';

function claimed(overrides: Record<string, string> = {}) {
  return {
    outboxId: OUTBOX_ID,
    webhookId: WEBHOOK_ID,
    endpoint: 'https://example.test/hook',
    logId: LOG_ID,
    ...overrides,
  };
}

beforeEach(() => {
  database.reset();
  globalThis.fetch = mock(async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('does nothing when the outbox is empty', async () => {
  database.script(rows());

  await tickWebhookProcessor();

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(database.calls.some((call) => call.method === 'delete')).toBe(false);
});

test('claims, posts, and records a successful delivery', async () => {
  database.script(rows(claimed()), rows(), rows());

  await tickWebhookProcessor();

  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  const [endpoint, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] ?? [];
  expect(endpoint).toBe('https://example.test/hook');
  expect(init).toMatchObject({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook_id: WEBHOOK_ID, log_id: LOG_ID }),
  });

  const values = database.calls.filter((call) => call.method === 'values').at(-1)?.args[0];
  expect(values).toEqual({ outbox_id: OUTBOX_ID, webhook_id: WEBHOOK_ID, status_code: 202 });
});

test('records status zero when an endpoint never returns a response', async () => {
  database.script(rows(claimed()), rows(), rows());
  globalThis.fetch = mock(async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;

  await tickWebhookProcessor();

  const values = database.calls.filter((call) => call.method === 'values').at(-1)?.args[0];
  expect(values).toEqual({ outbox_id: OUTBOX_ID, webhook_id: WEBHOOK_ID, status_code: 0 });
});

test('one failed endpoint does not prevent the rest of the claimed batch from being delivered', async () => {
  database.script(
    rows(claimed({ endpoint: 'https://bad.example.test' }), claimed({ outboxId: `${OUTBOX_ID.slice(0, -1)}8` })),
    rows(),
    rows(),
    rows(),
  );
  globalThis.fetch = mock(async (endpoint) => {
    if (endpoint === 'https://bad.example.test') {
      throw new Error('connection refused');
    }

    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  await tickWebhookProcessor();

  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  const attempts = database.calls
    .filter((call) => call.method === 'values')
    .map((call) => call.args[0] as { status_code: number });
  expect(attempts.map((attempt) => attempt.status_code)).toEqual([0, 204]);
});

test('a failure to write delivery history is contained within that delivery', async () => {
  database.script(rows(claimed()), rows(), failsWith(new Error('database unavailable')));

  await expect(tickWebhookProcessor()).resolves.toBeUndefined();
});
