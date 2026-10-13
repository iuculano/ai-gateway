import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SelectedOffering } from '../../src/worker/catalog-sync';
import { deleteExcludedModels, upsertCatalog } from '../../src/worker/catalog-upsert';
import { admin, prepareSuite, resetDatabase } from './setup';

const firstSnapshot: SelectedOffering[] = [
  {
    provider: 'openai',
    type: 'chat',
    offering: {
      id: 'gpt-test',
      name: 'GPT Test',
      status: 'beta',
      attachment: true,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      limit: { context: 128_000, output: 16_000 },
      cost: { input: 1.25, output: 5, cache_read: 0.25 },
      description: 'Catalog-owned description',
    },
  },
  { provider: 'openai', type: 'chat', offering: { id: 'unpriced' } },
  { provider: 'azure', type: 'chat', offering: { id: 'azure-test', cost: { input: 2, output: 8 } } },
];

beforeAll(prepareSuite);
beforeEach(resetDatabase);

afterAll(async () => {
  await resetDatabase();
  await admin.close();
});

async function readModel(provider: string, name: string, type = 'chat') {
  const [row] = await admin`
    select * from models where provider = ${provider} and name = ${name} and type = ${type}
  `;

  return row;
}

test('writes the upstream shape without turning an unknown price into free', async () => {
  expect(await upsertCatalog(firstSnapshot)).toEqual({ written: 3, delisted: 0, confirmed: 3 });

  expect(await readModel('openai', 'gpt-test')).toMatchObject({
    display_name: 'GPT Test',
    status: 'beta',
    cost_input: '1.250000000000',
    cost_output: '5.000000000000',
    cost_cache_read: '0.250000000000',
    context_limit: 128_000,
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
  });
  expect(await readModel('openai', 'unpriced')).toMatchObject({
    cost_input: null,
    cost_output: null,
    cost_cache_read: null,
  });
});

test('is idempotent, delists only providers present in the snapshot, and preserves providers absent from the snapshot', async () => {
  await upsertCatalog(firstSnapshot);
  const before = await readModel('openai', 'gpt-test');
  expect(await upsertCatalog(firstSnapshot)).toEqual({ written: 0, delisted: 0, confirmed: 3 });
  const unchanged = await readModel('openai', 'gpt-test');
  expect(unchanged?.updated_at).toEqual(before?.updated_at);

  const nextSnapshot: SelectedOffering[] = [
    {
      provider: 'openai',
      type: 'chat',
      offering: { ...firstSnapshot[0]?.offering, id: 'gpt-test', name: 'GPT Test Updated' },
    },
  ];
  expect(await upsertCatalog(nextSnapshot)).toEqual({ written: 1, delisted: 1, confirmed: 1 });

  expect(await readModel('openai', 'gpt-test')).toMatchObject({
    display_name: 'GPT Test Updated',
    delisted_at: null,
  });
  expect((await readModel('openai', 'unpriced'))?.delisted_at).toBeInstanceOf(Date);
  expect((await readModel('azure', 'azure-test'))?.delisted_at).toBeNull();
});

test('whitelist cleanup deletes excluded models, including for an empty whitelist', async () => {
  await upsertCatalog(firstSnapshot);

  expect(await deleteExcludedModels(['openai'])).toBe(1);
  expect(await readModel('azure', 'azure-test')).toBeUndefined();
  expect(await readModel('openai', 'gpt-test')).toBeDefined();
  expect(await deleteExcludedModels(['openai'])).toBe(0);

  expect(await deleteExcludedModels([])).toBe(2);
  expect(await readModel('openai', 'gpt-test')).toBeUndefined();
});

test('a model sold through two endpoints is two rows, and each is delisted on its own', async () => {
  const luna = { id: 'gpt-6-luna', cost: { input: 0.1, output: 0.5 } };
  const both: SelectedOffering[] = [
    { provider: 'openai', type: 'chat', offering: luna },
    { provider: 'openai', type: 'decision', offering: { ...luna, cost: { input: 0.1, output: 0 } } },
  ];

  expect(await upsertCatalog(both)).toEqual({ written: 2, delisted: 0, confirmed: 2 });
  expect(Number((await readModel('openai', 'gpt-6-luna', 'decision'))?.cost_output)).toBe(0);

  // Only decision rows in this snapshot: the chat row is out of scope, not missing.
  expect(await upsertCatalog([{ provider: 'openai', type: 'decision', offering: { id: 'other' } }])).toMatchObject({
    delisted: 1,
  });
  expect((await readModel('openai', 'gpt-6-luna', 'decision'))?.delisted_at).toBeInstanceOf(Date);
  expect((await readModel('openai', 'gpt-6-luna', 'chat'))?.delisted_at).toBeNull();
});

test('a redirect is stored and survives a resync', async () => {
  const redirect: SelectedOffering = {
    provider: 'typesafe-ai',
    type: 'decision',
    offering: { id: 'jev-latest' },
    redirect_to: 'jev',
  };

  await upsertCatalog([redirect]);
  expect(await upsertCatalog([redirect])).toMatchObject({ written: 0 });
  expect((await readModel('typesafe-ai', 'jev-latest', 'decision'))?.redirect_to).toBe('jev');
});
