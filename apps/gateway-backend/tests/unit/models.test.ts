import { beforeEach, expect, test } from 'bun:test';
import { database, failsWith, forCaller, installModuleMocks, MODEL_ID, modelRow, resetDoubles, rows } from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const Services = forCaller((await import('../../src/api/models/models.services')).default);

beforeEach(() => {
  resetDoubles();
});

test('getModel returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'models', rows());

  expect(expectErr(await Services.getModel(MODEL_ID))).toEqual({ code: 'MODEL_NOT_FOUND', id: MODEL_ID });
});

test('getModel rejects when the query fails', async () => {
  database.respondTo('select', 'models', failsWith(new Error('connection terminated')));

  await expect(Services.getModel(MODEL_ID)).rejects.toThrow('connection terminated');
});

test('getModelBySlug returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'models', rows());

  expect(expectErr(await Services.getModelBySlug('openai/missing-model'))).toEqual({
    code: 'MODEL_NOT_FOUND',
    slug: 'openai/missing-model',
  });
});

test.each(['gpt-4-turbo', '/model', 'openai/'])('malformed slugs are rejected without a query: %s', async (slug) => {
  expect(expectErr(await Services.getModelBySlug(slug))).toEqual({ code: 'MODEL_NOT_FOUND', slug });
  expect(database.queries).toHaveLength(0);
});

test('getModelBySlug reuses successful catalog lookups', async () => {
  database.respondTo('select', 'models', rows(modelRow({ name: 'cached-model' })));

  const first = expectOk(await Services.getModelBySlug('openai/cached-model'));
  const second = expectOk(await Services.getModelBySlug('openai/cached-model'));

  expect(second).toEqual(first);
  expect(database.queriesFor('select', 'models')).toHaveLength(1);
});

test('getModelBySlug does not cache missing models', async () => {
  database.respondTo('select', 'models', rows(), rows(modelRow({ name: 'new-model' })));

  expectErr(await Services.getModelBySlug('openai/new-model'));
  expect(expectOk(await Services.getModelBySlug('openai/new-model')).name).toBe('new-model');
  expect(database.queriesFor('select', 'models')).toHaveLength(2);
});

test('unset model fields remain present as null in single and list responses', async () => {
  const unset = {
    display_name: null,
    cost_input: null,
    cost_output: null,
    cost_cache_read: null,
    context_limit: null,
    config: null,
    tags: null,
    delisted_at: null,
    synced_at: null,
  };
  database.respondTo('select', 'models', rows(modelRow(unset)), rows(modelRow(unset)));

  const model = expectOk(await Services.getModel(MODEL_ID));
  const page = await Services.listModels({ limit: 50 });

  expect(model).toMatchObject(unset);
  expect(page.data[0]).toMatchObject(unset);
  expect(model.created_at).toBeInstanceOf(Date);
});
