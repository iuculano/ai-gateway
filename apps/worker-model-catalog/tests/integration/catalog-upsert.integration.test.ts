import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SelectedOffering } from '../../src/worker/catalog-sync';
import { deleteExcludedModels, upsertCatalog } from '../../src/worker/catalog-upsert';
import { admin, prepareSuite, resetDatabase } from './setup';

const firstSnapshot: SelectedOffering[] = [
  {
    provider: 'openai',
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
  { provider: 'openai', offering: { id: 'unpriced' } },
  { provider: 'azure', offering: { id: 'azure-test', cost: { input: 2, output: 8 } } },
];

beforeAll(prepareSuite);
beforeEach(resetDatabase);

afterAll(async () => {
  await resetDatabase();
  await admin.close();
});

async function readModel(provider: string, name: string) {
  const [row] = await admin`
    select * from models where provider = ${provider} and name = ${name}
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

test('migration preserves catalog rows and removes legacy custom rows and ownership columns', async () => {
  const migration = await Bun.file(
    new URL(
      '../../../../packages/drizzle/migrations/20260915011146_remove-custom-models/migration.sql',
      import.meta.url,
    ),
  ).text();
  await admin.begin(async (tx) => {
    await tx.unsafe(`create temp table models (
      id integer, provider text not null, name text not null,
      source text not null, organization_id uuid
    ) on commit drop`);
    await tx.unsafe(`create unique index models_builtin_key on models (provider, name) where source = 'builtin'`);
    await tx.unsafe(
      `create unique index models_custom_key on models (organization_id, provider, name) where source = 'custom'`,
    );
    await tx.unsafe('create index idx_models_on_provider_name on models (provider, name)');
    await tx.unsafe(`insert into models values
      (1, 'openai', 'retained', 'builtin', null),
      (2, 'openai', 'retained', 'custom', null),
      (3, 'openai', 'removed', 'custom', null)`);
    for (const statement of migration.split('--> statement-breakpoint')) {
      await tx.unsafe(statement);
    }
    const result = await tx`select * from models`;
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, provider: 'openai', name: 'retained' });
  });
});
