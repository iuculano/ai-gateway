import { afterAll, expect, mock, test } from 'bun:test';
import { CATALOG_SOURCE_IDS } from '@repo/core';
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

test('narrows a changed catalog to the allowlist and reuses its ETag on the next tick', async () => {
  const requests: RequestInit[] = [];
  const providers: Record<string, { id: string; models: Record<string, { id: string; cost?: { input: number } }> }> =
    Object.fromEntries(
      CATALOG_SOURCE_IDS.map((provider) => [
        provider,
        { id: provider, models: { [`${provider}-model`]: { id: `${provider}-model`, cost: { input: 1 } } } },
      ]),
    );
  providers.unused = { id: 'unused', models: { ignored: { id: 'ignored' } } };

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
  expect(synced[0]?.map((item) => item.provider)).toEqual([...CATALOG_SOURCE_IDS]);
  expect(synced[0]?.some((item) => item.offering.id === 'ignored')).toBe(false);
  expect(requests[0]?.headers).toEqual({});
  expect(requests[1]?.headers).toEqual({ 'if-none-match': '"catalog-revision-1"' });
});
