import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createDatabaseDouble, rows } from '@repo/test-helpers';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';
process.env.LOG_LEVEL = 'error';
process.env.CATALOG_PROVIDER_WHITELIST = ' openai, azure, google, anthropic, openrouter, additional-provider, ';

const originalFetch = globalThis.fetch;
const { database, db } = createDatabaseDouble();
const actualDrizzle = await import('@repo/drizzle');

// PostgreSQL is the system boundary for this worker. Keep the worker's own
// fetch, selection, and upsert modules real so the test observes one complete
// catalog-sync slice.
mock.module('@repo/drizzle', () => ({ ...actualDrizzle, db }));

const { selectOfferings, tickModelCatalog, toModelType } = await import('../../src/worker/catalog-sync');

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  database.assertResponsesConsumed();
});

test('writes only whitelisted providers in a changed catalog and reuses its ETag on the next tick', async () => {
  const requests: RequestInit[] = [];
  const providers = {
    openai: { id: 'openai', models: { 'gpt-test': { id: 'gpt-test', cost: { input: 1 } } } },
    azure: { id: 'azure', models: { deployment: { id: 'deployment' } } },
    google: { id: 'google', models: { gemini: { id: 'gemini' } } },
    anthropic: { id: 'anthropic', models: { claude: { id: 'claude' } } },
    openrouter: { id: 'openrouter', models: { claude: { id: 'anthropic/claude' } } },
    'additional-provider': { id: 'additional-provider', models: { additional: { id: 'additional' } } },
    unsupported: { id: 'unsupported', models: { unknown: { id: 'unknown' } } },
  };

  globalThis.fetch = mock(async (_input, init) => {
    requests.push(init ?? {});

    if (requests.length === 1) {
      return Response.json({ providers, models: {} }, { headers: { etag: '"catalog-revision-1"' } });
    }

    return new Response(null, { status: 304 });
  }) as unknown as typeof fetch;

  database.respondTo('delete', 'models', rows({ id: 'excluded' }), rows());
  database.respondTo('insert', 'models', rows({ id: 'openai/gpt-test' }));
  database.respondTo(
    'update',
    'models',
    rows(),
    rows(),
    rows(),
    rows(),
    rows(),
    rows(),
    rows(),
    rows({ id: 'openai/gpt-test' }),
  );

  await tickModelCatalog();
  await tickModelCatalog();

  const insert = database.queriesFor('insert', 'models')[0];
  const inserted = insert?.calls.find((call) => call.method === 'values')?.args[0] as
    | Record<string, unknown>[]
    | undefined;

  expect(inserted).toEqual([
    expect.objectContaining({ provider: 'openai', name: 'gpt-test', cost_input: 1 }),
    expect.objectContaining({ provider: 'azure', name: 'deployment', cost_input: null }),
    expect.objectContaining({ provider: 'google', name: 'gemini', cost_input: null }),
    expect.objectContaining({ provider: 'anthropic', name: 'claude', cost_input: null }),
    expect.objectContaining({ provider: 'openrouter', name: 'anthropic/claude', cost_input: null }),
    expect.objectContaining({ provider: 'additional-provider', name: 'additional' }),
    expect.objectContaining({ provider: 'openai', name: 'gpt-6-luna', type: 'decision', cost_output: 0 }),
  ]);
  expect(database.queriesFor('delete', 'models')).toHaveLength(2);
  // One delist per provider and type, then one confirmation.
  expect(database.queriesFor('update', 'models')).toHaveLength(8);
  expect(database.queries).toHaveLength(11);
  expect(requests[0]?.headers).toEqual({});
  expect(requests[1]?.headers).toEqual({ 'if-none-match': '"catalog-revision-1"' });
});

test('a snapshot containing only excluded providers still deletes excluded models and writes only the overlay', async () => {
  database.reset();
  database.respondTo('delete', 'models', rows({ id: 'excluded' }));
  database.respondTo('insert', 'models', rows());
  database.respondTo('update', 'models', rows(), rows());
  globalThis.fetch = mock(async () =>
    Response.json({
      providers: { unsupported: { id: 'unsupported', models: { unknown: { id: 'unknown' } } } },
      models: {},
    }),
  ) as unknown as typeof fetch;

  await tickModelCatalog();

  expect(database.queriesFor('delete', 'models')).toHaveLength(1);
  const insert = database.queriesFor('insert', 'models')[0];
  expect(insert?.calls.find((call) => call.method === 'values')?.args[0]).toEqual([
    expect.objectContaining({ provider: 'openai', name: 'gpt-6-luna', type: 'decision' }),
  ]);
});

test.each([
  [{ id: 'gpt-5' }, 'chat'],
  [{ id: 'text-embedding-3-small' }, 'embedding'],
  [{ id: 'gemini-Embedding-001' }, 'embedding'],
  [{ id: 'bge-m3', type: 'embedding' }, 'embedding'],
  [{ id: 'bge-reranker-v2-m3', type: 'reranking' }, null],
])('%o is typed %p', (offering, type) => {
  expect(toModelType(offering)).toBe(type as ReturnType<typeof toModelType>);
});

test('the overlay adds a decision row beside the chat row of the same name, and unserved types are dropped', () => {
  const selected = selectOfferings({
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-6-luna': { id: 'gpt-6-luna', cost: { input: 0.1, output: 0.5 } },
          reranker: { id: 'reranker', type: 'reranking' },
        },
      },
    },
  });

  expect(selected.map((item) => `${item.provider}/${item.type}/${item.offering.id}`)).toEqual([
    'openai/chat/gpt-6-luna',
    'openai/decision/gpt-6-luna',
  ]);
});
