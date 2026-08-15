import { beforeEach, expect, test } from 'bun:test';
import type { CreateRegexGuardrailBody } from '../../src/api/guardrails/guardrails.schemas';
import {
  audit,
  callerFixture,
  database,
  failsWith,
  installModuleMocks,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/guardrails/guardrails.services');

const GUARDRAIL_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000b';

beforeEach(() => {
  resetDoubles();
});

function asCaller<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFixture, work);
}

function guardrailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GUARDRAIL_ID,
    organization_id: ORGANIZATION_ID,
    name: 'no-ssn',
    // Nullable in the column and so nullable in the shape - but not optional,
    // which is the difference between null and simply leaving it out.
    description: null,
    type: 'regex',
    target: 'request',
    action: 'block',
    enabled: true,
    config: { pattern: '\\d{3}-\\d{2}-\\d{4}' },
    creator_id: USER_ID,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// --- the expected failures ---------------------------------------------------
//
// All three unions have a single code, so there is no scenario matrix: the
// assertNever in each handler mapper is what makes a new variant fail to
// compile, and a plain test says the rest.

const notFound = { code: 'GUARDRAIL_NOT_FOUND', id: GUARDRAIL_ID } as const;

test('getGuardrail returns GUARDRAIL_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await asCaller(() => Services.getGuardrail(GUARDRAIL_ID)))).toEqual(notFound);
});

test('updateRegexGuardrail returns GUARDRAIL_NOT_FOUND as a value', async () => {
  database.script(rows()); // select ... for update finds nothing

  expect(expectErr(await asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'renamed' })))).toEqual(
    notFound,
  );
});

test('deleteGuardrail returns GUARDRAIL_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await asCaller(() => Services.deleteGuardrail(GUARDRAIL_ID)))).toEqual(notFound);
});

// --- getGuardrail ------------------------------------------------------------

test('getGuardrail returns Ok', async () => {
  database.script(rows(guardrailRow()));

  const guardrail = expectOk(await asCaller(() => Services.getGuardrail(GUARDRAIL_ID)));

  expect(guardrail.id).toBe(GUARDRAIL_ID);
  expect(guardrail.type).toBe('regex');
});

test('getGuardrail rejects when the query fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(asCaller(() => Services.getGuardrail(GUARDRAIL_ID))).rejects.toThrow('connection terminated');
});

// --- updateRegexGuardrail ----------------------------------------------------

test('a guardrail of another type refuses exactly like a missing one', async () => {
  // /guardrails/regex/:id addresses regex guardrails, and this id is not one of
  // them. A distinct code would confirm the id exists as something else, which
  // the caller has not asked about - so the service does not produce one and
  // the handler has nothing it could accidentally leak.
  database.script(rows(guardrailRow({ type: 'semantic' })));

  const failure = expectErr(await asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'renamed' })));

  expect(failure).toEqual({ code: 'GUARDRAIL_NOT_FOUND', id: GUARDRAIL_ID });
  expect(audit.calls).toHaveLength(0);
});

test('updateRegexGuardrail returns Ok and audits the difference', async () => {
  database.script(rows(guardrailRow()), rows(guardrailRow({ name: 'renamed' })));

  const updated = expectOk(await asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'renamed' })));

  expect(updated.name).toBe('renamed');
  expect(database.transactions[0]?.committed).toBe(true);
  expect(audit.calls[0]?.body).toMatchObject({
    event: 'guardrails.updated',
    status: 'success',
    difference: { name: { old: 'no-ssn', new: 'renamed' } },
  });
});

test('a no-op update returns Ok and writes nothing', async () => {
  // Only the select is scripted: an update would run off the end of the script
  // and reject, which is how this test knows one was not issued.
  database.script(rows(guardrailRow()));

  expect((await asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'no-ssn' }))).isOk()).toBe(true);
  expect(audit.calls).toHaveLength(0);
});

test('updateRegexGuardrail rolls back when the audit write fails', async () => {
  database.script(rows(guardrailRow()), rows(guardrailRow({ name: 'renamed' })));
  audit.failure = new Error('audit log unavailable');

  await expect(asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'renamed' }))).rejects.toThrow(
    'audit log unavailable',
  );

  expect(database.transactions[0]?.rolledBack).toBe(true);
});

test('updateRegexGuardrail rejects when the update returns no row', async () => {
  database.script(rows(guardrailRow()), rows());

  await expect(asCaller(() => Services.updateRegexGuardrail(GUARDRAIL_ID, { name: 'renamed' }))).rejects.toThrow(
    'Failed to update guardrail',
  );
});

// --- deleteGuardrail ---------------------------------------------------------

test('deleteGuardrail returns Ok and records what was being enforced', async () => {
  database.script(rows(guardrailRow()));

  expect((await asCaller(() => Services.deleteGuardrail(GUARDRAIL_ID))).isOk()).toBe(true);

  // The row is gone, so the audit entry is the only remaining record of it.
  expect(audit.calls[0]?.body).toMatchObject({
    event: 'guardrails.deleted',
    metadata: { name: 'no-ssn', type: 'regex', action: 'block' },
  });
});

test('deleteGuardrail rolls back when the audit write fails', async () => {
  database.script(rows(guardrailRow()));
  audit.failure = new Error('audit log unavailable');

  await expect(asCaller(() => Services.deleteGuardrail(GUARDRAIL_ID))).rejects.toThrow('audit log unavailable');

  expect(database.transactions[0]?.rolledBack).toBe(true);
});

// --- the operations that stay plain promises ---------------------------------

test('createRegexGuardrail stays a plain promise', async () => {
  database.script(rows(guardrailRow()));

  const created = await asCaller(() =>
    Services.createRegexGuardrail({
      name: 'no-ssn',
      target: 'request',
      action: 'block',
      config: { pattern: '\\d{3}' },
    } as CreateRegexGuardrailBody),
  );

  // Deliberately not a Result: nothing about a create is refusable.
  expect('isOk' in created).toBe(false);
  expect(created.id).toBe(GUARDRAIL_ID);
});

test('createRegexGuardrail takes the organization and creator from the caller', async () => {
  database.script(rows(guardrailRow()));

  await asCaller(() =>
    Services.createRegexGuardrail({
      name: 'no-ssn',
      target: 'request',
      action: 'block',
      config: { pattern: '\\d{3}' },
    } as CreateRegexGuardrailBody),
  );

  const values = database.calls.find((call) => call.method === 'values')?.args[0] as Record<string, unknown>;

  expect(values.organization_id).toBe(ORGANIZATION_ID);
  expect(values.creator_id).toBe(USER_ID);

  // The route decides the type, not the body.
  expect(values.type).toBe('regex');
});

test('createRegexGuardrail rejects when the insert returns no row', async () => {
  database.script(rows());

  await expect(
    asCaller(() =>
      Services.createRegexGuardrail({
        name: 'no-ssn',
        target: 'request',
        action: 'block',
        config: { pattern: '\\d{3}' },
      } as CreateRegexGuardrailBody),
    ),
  ).rejects.toThrow('Failed to insert guardrail');
});

test('listGuardrails stays a plain promise', async () => {
  database.script(rows(guardrailRow()));

  const page = await asCaller(() => Services.listGuardrails({ limit: 50 }));

  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
});
