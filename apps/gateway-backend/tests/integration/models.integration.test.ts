// ./setup rewrites POSTGRES_CONNECTION_STRING and is loaded by --preload, so
// the order of these imports does not matter. See the test:integration script.
import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/models/models.services';
import { admin, callerFor, prepareSuite, readAuditRows, resetDatabase, seedTenant, type Tenant } from './setup';

/**
 * The model catalogue, against a real database.
 *
 * There is no tenancy to test here - `models` has no organization_id and is
 * global by design - so this covers the other thing a double cannot: whether
 * the rows postgres actually returns survive the response schema. `cost_input`
 * and `cost_output` are `numeric`, which the driver hands back as strings, and
 * `config`/`tags` are jsonb with defaults. Getting either wrong is a 500 on
 * every read, which is exactly the shape of the bug the webhooks suite found.
 */

beforeAll(prepareSuite);

let tenant: Tenant;

beforeEach(async () => {
  await resetDatabase();
  tenant = await seedTenant('models');
});

function asCaller<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFor(tenant, ['models:read', 'models:write']), work);
}

async function createModel(overrides: Record<string, unknown> = {}) {
  return asCaller(() =>
    Services.createModel({
      name: 'gpt-4-turbo',
      provider: 'openai',
      ...overrides,
      // biome-ignore lint/suspicious/noExplicitAny: the create body is the schema's to police, not this fixture's
    } as any),
  );
}

test('a model round-trips through the response schema', async () => {
  const created = await createModel({ cost_input: 0.00001, cost_output: 0.00003 });

  const fetched = await Services.getModel(created.id);

  expect(fetched.isOk()).toBe(true);

  const model = fetched._unsafeUnwrap();
  expect(model.name).toBe('gpt-4-turbo');

  // The column is numeric, so the driver returns a string. If the schema ever
  // stops coercing, this is what catches it.
  expect(model.cost_input).toBe(0.00001);
  expect(typeof model.cost_input).toBe('number');
});

test('a model created without config or tags reads back', async () => {
  // Both columns default to {} rather than null, which is what keeps them out
  // of the trap the webhooks schema fell into.
  const created = await createModel();

  const row = await admin`select config, tags from models where id = ${created.id}`;
  expect(row[0]?.config).toEqual({});

  expect((await Services.getModel(created.id)).isOk()).toBe(true);
});

test('an unknown id refuses rather than throwing', async () => {
  const missing = '01912d3f-9b4a-7c3d-8e2f-0000000000ff';

  expect((await Services.getModel(missing))._unsafeUnwrapErr().code).toBe('MODEL_NOT_FOUND');
  expect((await asCaller(() => Services.updateModel(missing, { name: 'x' })))._unsafeUnwrapErr().code).toBe(
    'MODEL_NOT_FOUND',
  );
  expect((await asCaller(() => Services.deleteModel(missing)))._unsafeUnwrapErr().code).toBe('MODEL_NOT_FOUND');
});

test('getModelBySlug finds a model by provider and name', async () => {
  const created = await createModel();
  await createModel({ name: 'claude-opus', provider: 'anthropic' });

  const found = await Services.getModelBySlug('openai/gpt-4-turbo');

  expect(found._unsafeUnwrap().id).toBe(created.id);
});

test('getModelBySlug refuses a slug that names nothing', async () => {
  await createModel();

  const result = await Services.getModelBySlug('anthropic/gpt-4-turbo');

  // The provider and the name both have to match - a real model name under the
  // wrong provider is not a match.
  expect(result._unsafeUnwrapErr().code).toBe('MODEL_NOT_FOUND');
});

test('an update writes and a delete removes', async () => {
  const created = await createModel();

  const updated = await asCaller(() => Services.updateModel(created.id, { name: 'gpt-4o' }));
  expect(updated._unsafeUnwrap().name).toBe('gpt-4o');

  expect((await asCaller(() => Services.deleteModel(created.id))).isOk()).toBe(true);
  expect(await admin`select 1 from models where id = ${created.id}`).toHaveLength(0);

  const audits = await readAuditRows(created.id);
  expect(audits.map((audit: { event: string }) => audit.event)).toEqual([
    'models.created',
    'models.updated',
    'models.deleted',
  ]);
  expect(audits[1]?.difference).toEqual({ name: { old: 'gpt-4-turbo', new: 'gpt-4o' } });

  // Deletion is not idempotent: the row is gone, so a second call is
  // indistinguishable from one for an id that never existed.
  expect((await asCaller(() => Services.deleteModel(created.id)))._unsafeUnwrapErr().code).toBe('MODEL_NOT_FOUND');
});

test('a failing model audit write rolls the update back', async () => {
  const created = await createModel();

  await admin.unsafe(
    "alter table audit_logs add constraint audit_models_integration_block check (event <> 'models.updated')",
  );

  try {
    await expect(asCaller(() => Services.updateModel(created.id, { name: 'renamed' }))).rejects.toThrow();
  } finally {
    await admin.unsafe('alter table audit_logs drop constraint audit_models_integration_block');
  }

  expect((await admin`select name from models where id = ${created.id}`)[0]?.name).toBe('gpt-4-turbo');
});

test('the cursor walks the catalogue exactly once', async () => {
  const created = [
    await createModel({ name: 'one' }),
    await createModel({ name: 'two' }),
    await createModel({ name: 'three' }),
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
  await createModel();
  const anthropic = await createModel({ name: 'claude-opus', provider: 'anthropic' });

  const page = await Services.listModels({ limit: 50, provider: 'anthropic' });

  expect(page.data.map((model) => model.id)).toEqual([anthropic.id]);
});
