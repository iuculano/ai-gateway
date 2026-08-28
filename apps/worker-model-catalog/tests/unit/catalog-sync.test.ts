import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createDatabaseDouble, rows } from '@repo/test-helpers';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';
process.env.LOG_LEVEL = 'error';

const originalFetch = globalThis.fetch;
const { database, db } = createDatabaseDouble();
const actualDrizzle = await import('@repo/drizzle');

// PostgreSQL is the system boundary for this worker. Keep the worker's own
// fetch, selection, and upsert modules real so the test observes one complete
// catalogue-sync slice.
mock.module('@repo/drizzle', () => ({ ...actualDrizzle, db }));

const { tickModelCatalog } = await import('../../src/worker/catalog-sync');

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  database.assertResponsesConsumed();
});

test('writes every provider in a changed catalog and reuses its ETag on the next tick', async () => {
  const requests: RequestInit[] = [];
  const providers = {
    openai: { id: 'openai', models: { 'gpt-test': { id: 'gpt-test', cost: { input: 1 } } } },
    unsupported: { id: 'unsupported', models: { unknown: { id: 'unknown' } } },
  };

  globalThis.fetch = mock(async (_input, init) => {
    requests.push(init ?? {});

    if (requests.length === 1) {
      return Response.json({ providers, models: {} }, { headers: { etag: '"catalog-revision-1"' } });
    }

    return new Response(null, { status: 304 });
  }) as unknown as typeof fetch;

  database.respondTo('insert', 'models', rows({ id: 'openai/gpt-test' }, { id: 'unsupported/unknown' }));
  database.respondTo(
    'update',
    'models',
    rows(),
    rows(),
    rows({ id: 'openai/gpt-test' }, { id: 'unsupported/unknown' }),
  );

  await tickModelCatalog();
  await tickModelCatalog();

  const insert = database.queriesFor('insert', 'models')[0];
  const inserted = insert?.calls.find((call) => call.method === 'values')?.args[0] as
    | Record<string, unknown>[]
    | undefined;

  expect(inserted).toEqual([
    expect.objectContaining({ provider: 'openai', name: 'gpt-test', cost_input: 1 }),
    expect.objectContaining({ provider: 'unsupported', name: 'unknown', cost_input: null }),
  ]);
  expect(database.queries).toHaveLength(4);
  expect(requests[0]?.headers).toEqual({});
  expect(requests[1]?.headers).toEqual({ 'if-none-match': '"catalog-revision-1"' });
});
