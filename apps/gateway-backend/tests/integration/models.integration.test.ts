// ./setup rewrites POSTGRES_CONNECTION_STRING and is loaded by --preload, so
// the order of these imports does not matter. See the test:integration script.
import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/models/models.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant } from './setup';

// Catalog models are global and maintained by the sync worker.

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  await seedTenant('models');
});

async function seedModel(
  overrides: { name?: string; provider?: string; cost_input?: number; cost_output?: number } = {},
) {
  const [model] = await admin`
    insert into models (name, provider, cost_input, cost_output)
    values (${overrides.name ?? 'gpt-4-turbo'}, ${overrides.provider ?? 'openai'},
      ${overrides.cost_input ?? null}, ${overrides.cost_output ?? null}) returning *
  `;
  if (!model) throw new Error('Failed to seed catalog model');
  return model;
}

test('a model round-trips through the response schema', async () => {
  const created = await seedModel({ cost_input: 0.00001, cost_output: 0.00003 });

  const fetched = await Services.getModel(created.id);

  expect(fetched.isOk()).toBe(true);

  const model = fetched._unsafeUnwrap();
  expect(model.name).toBe('gpt-4-turbo');

  expect(model.cost_input).toBe(0.00001);
  expect(model.created_at).toBeInstanceOf(Date);
  expect(model.config).toEqual({});
  expect(model.tags).toEqual({});
});

test('slug lookups preserve upstream namespaces', async () => {
  const created = await seedModel({ provider: 'openrouter', name: 'anthropic/claude-sonnet-4' });
  await seedModel({ name: 'claude-sonnet-4', provider: 'anthropic' });

  const found = await Services.getModelBySlug('openrouter/anthropic/claude-sonnet-4');

  expect(found._unsafeUnwrap().id).toBe(created.id);
});

test('getModelBySlug refuses a slug that names nothing', async () => {
  await seedModel();

  const result = await Services.getModelBySlug('anthropic/gpt-4-turbo');

  // The provider and the name both have to match - a real model name under the
  // wrong provider is not a match.
  expect(result._unsafeUnwrapErr().code).toBe('MODEL_NOT_FOUND');
});

test('the cursor walks the catalog exactly once', async () => {
  const created = [
    await seedModel({ name: 'one' }),
    await seedModel({ name: 'two' }),
    await seedModel({ name: 'three' }),
  ];

  const first = await Services.listModels({ limit: 2 });
  expect(first.data).toHaveLength(2);
  expect(first.meta.more_data).toBe(true);

  const second = await Services.listModels({ limit: 2, after_id: first.meta.oldest_id ?? undefined });
  expect(second.data).toHaveLength(1);
  expect(second.meta.more_data).toBe(false);

  // Newest first, every model seen once.
  const seen = [...first.data, ...second.data].map((model) => model.id);
  expect(seen).toEqual(created.map((model) => model.id).reverse());
});

test('the provider filter narrows the list', async () => {
  await seedModel();
  const anthropic = await seedModel({ name: 'claude-opus', provider: 'anthropic' });

  const page = await Services.listModels({ limit: 50, provider: 'anthropic' });

  expect(page.data.map((model) => model.id)).toEqual([anthropic.id]);
});

test('provider and model name are globally unique', async () => {
  await seedModel();
  await expect(seedModel()).rejects.toThrow();
  const other = await seedTenant('other-model-reader');
  const providers = await runWithCaller(callerFor(other, ['models:read']), () => Services.listProviders({ limit: 50 }));
  expect(providers.data[0]?.models[0]?.name).toBe('gpt-4-turbo');
});

test('provider pagination keeps all models together and advances alphabetically', async () => {
  await seedModel({ provider: 'anthropic', name: 'claude-a' });
  await seedModel({ provider: 'anthropic', name: 'claude-b' });
  await seedModel({ provider: 'openai', name: 'gpt-a' });

  const first = await Services.listProviders({ limit: 1 });
  expect(first.data.map((provider) => provider.id)).toEqual(['anthropic']);
  expect(first.data[0]?.models.map((model) => model.name)).toEqual(['claude-a', 'claude-b']);
  expect(first.meta).toEqual({ oldest_id: 'anthropic', more_data: true });

  const second = await Services.listProviders({ limit: 1, after_id: first.meta.oldest_id as string });
  expect(second.data.map((provider) => provider.id)).toEqual(['openai']);
  expect(second.meta).toEqual({ oldest_id: 'openai', more_data: false });

  const empty = await Services.listProviders({ limit: 1, after_id: 'openai' });
  expect(empty).toEqual({ data: [], meta: { oldest_id: null, more_data: false } });
});
