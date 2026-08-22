import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SelectedOffering } from '../../src/worker/catalog-sync';
import { upsertCatalog } from '../../src/worker/catalog-upsert';
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

async function readModel(source: string, provider: string, name: string) {
  const [row] = await admin`
    select * from models where source = ${source} and provider = ${provider} and name = ${name}
  `;

  return row;
}

test('writes the upstream shape without turning an unknown price into free', async () => {
  expect(await upsertCatalog(firstSnapshot)).toEqual({ written: 3, delisted: 0, confirmed: 3 });

  expect(await readModel('builtin', 'openai', 'gpt-test')).toMatchObject({
    organization_id: null,
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
  expect(await readModel('builtin', 'openai', 'unpriced')).toMatchObject({
    cost_input: null,
    cost_output: null,
    cost_cache_read: null,
  });
});

test('is idempotent, delists only providers present in the snapshot, and leaves custom rows alone', async () => {
  const [organization] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values ('catalog-test', 'test-idp', 'Catalog Test', 'catalog-test')
    returning id
  `;
  if (!organization) {
    throw new Error('Failed to seed the catalog integration test');
  }

  await admin`
    insert into models (organization_id, source, provider, name, display_name, tags)
    values (${organization.id}, 'custom', 'openai', 'gpt-test', 'My Deployment', '{"owner":"operator"}')
  `;

  await upsertCatalog(firstSnapshot);
  const before = await readModel('builtin', 'openai', 'gpt-test');
  expect(await upsertCatalog(firstSnapshot)).toEqual({ written: 0, delisted: 0, confirmed: 3 });
  const unchanged = await readModel('builtin', 'openai', 'gpt-test');
  expect(unchanged?.updated_at).toEqual(before?.updated_at);

  const nextSnapshot: SelectedOffering[] = [
    {
      provider: 'openai',
      offering: { ...firstSnapshot[0]?.offering, id: 'gpt-test', name: 'GPT Test Updated' },
    },
  ];
  expect(await upsertCatalog(nextSnapshot)).toEqual({ written: 1, delisted: 1, confirmed: 1 });

  expect(await readModel('builtin', 'openai', 'gpt-test')).toMatchObject({
    display_name: 'GPT Test Updated',
    delisted_at: null,
  });
  expect((await readModel('builtin', 'openai', 'unpriced'))?.delisted_at).toBeInstanceOf(Date);
  expect((await readModel('builtin', 'azure', 'azure-test'))?.delisted_at).toBeNull();
  expect(await readModel('custom', 'openai', 'gpt-test')).toMatchObject({
    display_name: 'My Deployment',
    tags: { owner: 'operator' },
    synced_at: null,
    delisted_at: null,
  });
});
