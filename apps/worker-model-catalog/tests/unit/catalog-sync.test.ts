import { afterAll, expect, mock, test } from 'bun:test';
import type { SelectedOffering } from '../../src/worker/catalog-sync';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';

const originalFetch = globalThis.fetch;
const synced: SelectedOffering[][] = [];

mock.module('../../src/worker/catalog-upsert', () => ({
  upsertCatalog: async (selected: SelectedOffering[]) => {
    synced.push(selected);
    return { written: selected.length, delisted: 0, confirmed: selected.length };
  },
}));

const { tickModelCatalog } = await import('../../src/worker/catalog-sync');

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('syncs every provider in a changed catalog and reuses its ETag on the next tick', async () => {
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

  await tickModelCatalog();
  await tickModelCatalog();

  expect(synced).toHaveLength(1);
  expect(synced[0]?.map((item) => item.provider)).toEqual(['openai', 'unsupported']);
  expect(requests[0]?.headers).toEqual({});
  expect(requests[1]?.headers).toEqual({ 'if-none-match': '"catalog-revision-1"' });
});
