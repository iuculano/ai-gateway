import { beforeEach, expect, mock, test } from 'bun:test';
import { createDatabaseDouble, failsWith, rows } from '@repo/test-helpers';
import type { SelectedOffering } from '../../src/worker/catalog-sync';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';

const { database, db } = createDatabaseDouble();
const actualDrizzle = await import('@repo/drizzle');

mock.module('@repo/drizzle', () => ({ ...actualDrizzle, db }));

const { upsertCatalog } = await import('../../src/worker/catalog-upsert');

const selected: SelectedOffering[] = [
  {
    provider: 'openai',
    offering: {
      id: 'gpt-test',
      name: 'GPT Test',
      status: 'beta',
      description: 'A test model',
      family: 'gpt',
      attachment: true,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 128_000, output: 16_000 },
      cost: { input: 1.25, output: 5, cache_read: 0.25, cache_write: 2.5, reasoning: 3 },
    },
  },
  { provider: 'openai', offering: { id: 'unpriced' } },
];

beforeEach(() => {
  database.reset();
});

test('an empty snapshot is a no-op rather than a mass delist', async () => {
  expect(await upsertCatalog([])).toEqual({ written: 0, delisted: 0, confirmed: 0 });
  expect(database.transactions).toHaveLength(0);
});

test('maps upstream fields, preserves unknown prices as null, and reports each phase', async () => {
  database.script(rows({ id: 'written' }), rows({ id: 'delisted' }), rows({ id: 'one' }, { id: 'two' }));

  expect(await upsertCatalog(selected)).toEqual({ written: 1, delisted: 1, confirmed: 2 });

  const values = database.calls.find((call) => call.method === 'values')?.args[0] as Record<string, unknown>[];
  expect(values[0]).toMatchObject({
    source: 'builtin',
    organization_id: null,
    provider: 'openai',
    name: 'gpt-test',
    display_name: 'GPT Test',
    status: 'beta',
    cost_input: 1.25,
    cost_output: 5,
    cost_cache_read: 0.25,
    context_limit: 128_000,
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
  });
  expect(values[0]?.config).toEqual({
    description: 'A test model',
    family: 'gpt',
    modalities: { input: ['text'], output: ['text'] },
    knowledge: null,
    release_date: null,
    last_updated: null,
    output_limit: 16_000,
    cost_cache_write: 2.5,
    cost_reasoning: 3,
  });
  expect(values[1]).toMatchObject({
    name: 'unpriced',
    status: 'available',
    cost_input: null,
    cost_output: null,
    cost_cache_read: null,
  });
});

test('rolls the whole catalog update back when a statement fails', async () => {
  database.script(failsWith(new Error('deadlock detected')));

  await expect(upsertCatalog(selected)).rejects.toThrow('deadlock detected');
  expect(database.transactions).toEqual([{ committed: false, rolledBack: true }]);
});
