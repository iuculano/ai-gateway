import { beforeEach, expect, test } from 'bun:test';
import type { CreateModelRequest } from '../../src/api/models/models.schemas';
import {
  auditWrites,
  database,
  failsWith,
  forCaller,
  installModuleMocks,
  MODEL_ID,
  modelRow,
  resetDoubles,
  rows,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const Services = forCaller((await import('../../src/api/models/models.services')).default);

beforeEach(() => {
  resetDoubles();
});

// The expected failures
//
// Every union here has a single code, so there is no scenario matrix: the
// assertNever in each handler mapper is what makes a new variant fail to
// compile, and a plain test says the rest.

test('getModel returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'models', rows());

  expect(expectErr(await Services.getModel(MODEL_ID))).toEqual({ code: 'MODEL_NOT_FOUND', id: MODEL_ID });
});

test('updateModel returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'models', rows());

  expect(expectErr(await Services.updateModel(MODEL_ID, { name: 'renamed' }))).toEqual({
    code: 'MODEL_NOT_FOUND',
    id: MODEL_ID,
  });
});

test('deleteModel returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('delete', 'models', rows());

  expect(expectErr(await Services.deleteModel(MODEL_ID))).toEqual({ code: 'MODEL_NOT_FOUND', id: MODEL_ID });
});

// getModel

test('getModel returns Ok and coerces the numeric columns', async () => {
  database.respondTo('select', 'models', rows(modelRow()));

  const model = expectOk(await Services.getModel(MODEL_ID));

  expect(model.id).toBe(MODEL_ID);

  // The driver hands numeric back as a string; the response shape coerces it,
  // so a caller never has to know that.
  expect(model.cost_input).toBe(0.00001);
  expect(typeof model.cost_input).toBe('number');
});

test('getModel rejects when the query fails', async () => {
  database.respondTo('select', 'models', failsWith(new Error('connection terminated')));

  await expect(Services.getModel(MODEL_ID)).rejects.toThrow('connection terminated');
});

test('getModel rejects when the row will not parse', async () => {
  database.respondTo('select', 'models', rows({ id: 'not-a-uuid' }));

  await expect(Services.getModel(MODEL_ID)).rejects.toThrow();
});

// getModelBySlug

test('getModelBySlug returns Ok for a provider/name slug', async () => {
  database.respondTo('select', 'models', rows(modelRow()));

  const model = expectOk(await Services.getModelBySlug('openai/gpt-4-turbo'));

  expect(model.provider).toBe('openai');
  expect(model.name).toBe('gpt-4-turbo');
});

test('getModelBySlug returns MODEL_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'models', rows());

  // Carries the slug rather than an id - an id would be an answer this lookup
  // never found.
  expect(expectErr(await Services.getModelBySlug('openai/gpt-4-turbo'))).toEqual({
    code: 'MODEL_NOT_FOUND',
    slug: 'openai/gpt-4-turbo',
  });
});

test('a malformed slug refuses without touching the database', async () => {
  // No database response is arranged: a query would reject as unconfigured,
  // which is how this test knows the lookup was skipped. A slug with no slash
  // cannot name a model, so there is nothing to ask postgres.
  const failure = expectErr(await Services.getModelBySlug('gpt-4-turbo'));

  expect(failure).toEqual({ code: 'MODEL_NOT_FOUND', slug: 'gpt-4-turbo' });
});

test('a slug with too many segments refuses the same way', async () => {
  const failure = expectErr(await Services.getModelBySlug('openai/gpt-4/turbo'));

  // Deliberately the same answer as a model that is simply absent: a caller
  // probing for which providers exist learns nothing from the refusal.
  expect(failure.code).toBe('MODEL_NOT_FOUND');
});

// updateModel and deleteModel

test('updateModel returns Ok', async () => {
  database.respondTo('select', 'models', rows(modelRow()));
  database.respondTo('update', 'models', rows(modelRow({ name: 'renamed' })));

  const updated = expectOk(await Services.updateModel(MODEL_ID, { name: 'renamed' }));

  expect(updated.name).toBe('renamed');
  expect(auditWrites.calls).toHaveLength(1);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'models.updated',
    target_type: 'model',
    target_id: MODEL_ID,
    difference: { name: { old: 'gpt-4-turbo', new: 'renamed' } },
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('updateModel rejects when the update fails', async () => {
  database.respondTo('select', 'models', rows(modelRow()));
  database.respondTo('update', 'models', failsWith(new Error('deadlock detected')));

  await expect(Services.updateModel(MODEL_ID, { name: 'renamed' })).rejects.toThrow('deadlock detected');
});

test('deleteModel returns Ok when a row was removed', async () => {
  database.respondTo('delete', 'models', rows(modelRow()));

  expect((await Services.deleteModel(MODEL_ID)).isOk()).toBe(true);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'models.deleted',
    target_type: 'model',
    target_id: MODEL_ID,
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('deleteModel rejects when the delete fails', async () => {
  database.respondTo('delete', 'models', failsWith(new Error('connection terminated')));

  await expect(Services.deleteModel(MODEL_ID)).rejects.toThrow('connection terminated');
});

// The operations that stay plain promises

test('createModel stays a plain promise', async () => {
  database.respondTo('insert', 'models', rows(modelRow()));

  const created = await Services.createModel({ name: 'gpt-4-turbo', provider: 'openai' } as CreateModelRequest);

  // Deliberately not a Result: there is no uniqueness constraint on
  // provider/name, so there is nothing about a create to refuse.
  expect('isOk' in created).toBe(false);
  expect(created.id).toBe(MODEL_ID);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'models.created',
    target_type: 'model',
    target_id: MODEL_ID,
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('createModel rejects when the insert returns no row', async () => {
  database.respondTo('insert', 'models', rows());

  await expect(Services.createModel({ name: 'x', provider: 'y' } as CreateModelRequest)).rejects.toThrow(
    'Failed to create model',
  );
});

test('listModels stays a plain promise', async () => {
  database.respondTo('select', 'models', rows(modelRow()));

  const page = await Services.listModels({ limit: 50 });

  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
  expect(page.meta).toEqual({ oldest_id: MODEL_ID, more_data: false });
});

test('listModels rejects when the query fails', async () => {
  database.respondTo('select', 'models', failsWith(new Error('connection terminated')));

  await expect(Services.listModels({ limit: 50 })).rejects.toThrow('connection terminated');
});
