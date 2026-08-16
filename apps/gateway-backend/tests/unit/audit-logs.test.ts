import { beforeEach, expect, test } from 'bun:test';
import {
  audit,
  database,
  failsWith,
  installModuleMocks,
  KEY_ID,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr } from './result';

await installModuleMocks();

const { default: Services } = await import('../../src/api/audit-logs/audit-logs.services');
const { default: Schemas } = await import('../../src/api/audit-logs/audit-logs.schemas');

const AUDIT_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000a';

beforeEach(() => {
  resetDoubles();

  // This suite is testing the real audit service, so writes go through it
  // rather than into the stand-in. Set per test rather than at install time:
  // mock.module is process-wide and bun decides the file order.
  audit.passthrough = true;
});

/** A joined row, as the select in getAuditLog projects it. */
function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    log: {
      id: AUDIT_ID,
      organization_id: ORGANIZATION_ID,
      event: 'api-keys.created',
      target_type: 'api_key',
      target_id: KEY_ID,
      status: 'success',
      actor_type: 'user',
      actor_id: USER_ID,
      request_id: null,
      ip: null,
      user_agent: null,
      metadata: null,
      difference: null,
      occurred_at: new Date('2026-01-01T00:00:00.000Z'),
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    },
    actor_username: 'alex',
    actor_name: 'Alex',
    actor_email: 'alex@example.test',
    actor_api_key_name: null,
  };
}

// --- the expected failure ----------------------------------------------------

test('getAuditLog returns AUDIT_LOG_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await Services.getAuditLog(AUDIT_ID))).toEqual({
    code: 'AUDIT_LOG_NOT_FOUND',
    id: AUDIT_ID,
  });
});

test('getAuditLog returns Ok with the actor resolved', async () => {
  database.script(rows(auditRow()));

  const result = await Services.getAuditLog(AUDIT_ID);

  expect(result.isOk()).toBe(true);
  expect(result._unsafeUnwrap().actor_name).toBe('Alex');
});

test('getAuditLog rejects when the query fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(Services.getAuditLog(AUDIT_ID)).rejects.toThrow('connection terminated');
});

// --- the operations that stay plain promises ---------------------------------

test('listAuditLogs stays a plain promise', async () => {
  database.script(rows(auditRow()));

  const page = await Services.listAuditLogs({ limit: 50 });

  // Deliberately not a Result: there is no expected failure to model.
  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
});

test('createAuditLog rejects when the insert returns no row', async () => {
  // Internal - written by other services inside their own transactions, never
  // reached over HTTP, so there is nobody to hand a refusal to.
  database.script(rows());

  await expect(
    Services.createAuditLog({
      event: 'api-keys.created',
      target_type: 'api_key',
      status: 'success',
    }),
  ).rejects.toThrow('Failed to insert audit log');
});

// --- the query schema --------------------------------------------------------

test('actor_type survives validation', () => {
  // listAuditLogs has always applied this filter; it was simply never declared,
  // so the field was stripped before the service ever saw it and pairing it
  // with actor_id - the documented way to disambiguate a key id from a user id
  // - silently did nothing.
  const parsed = Schemas.listAuditLogs.query.parse({ actor_type: 'api_key', actor_id: USER_ID });

  expect(parsed.actor_type).toBe('api_key');
});

test('an actor_type outside the column enum is rejected', () => {
  expect(Schemas.listAuditLogs.query.safeParse({ actor_type: 'robot' }).success).toBe(false);
});
