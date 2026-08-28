import { beforeEach, expect, test } from 'bun:test';
import type { CreateWebhookBody } from '../../src/api/webhooks/webhooks.schemas';
import {
  auditWrites,
  callerFixture,
  database,
  failsWith,
  installModuleMocks,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
  WEBHOOK_ID,
  webhookRow,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const { runWithCaller } = await import('@repo/hono');
const { default: Services, ...rest } = await import('../../src/api/webhooks/webhooks.services');

// Silences the unused binding while keeping the import shape obvious.
void rest;

beforeEach(() => {
  resetDoubles();
});

function asCaller<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFixture, work);
}

// The expected failures
//
// All three unions have a single code, so there is no scenario matrix here: the
// assertNever in each handler mapper is what makes a new variant fail to
// compile, and a plain test says the rest.

test('getWebhook returns WEBHOOK_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'webhooks', rows());

  expect(expectErr(await asCaller(() => Services.getWebhook(WEBHOOK_ID)))).toEqual({
    code: 'WEBHOOK_NOT_FOUND',
    id: WEBHOOK_ID,
  });
});

test('updateWebhook returns WEBHOOK_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'webhooks', rows());

  expect(expectErr(await asCaller(() => Services.updateWebhook(WEBHOOK_ID, { name: 'renamed' })))).toEqual({
    code: 'WEBHOOK_NOT_FOUND',
    id: WEBHOOK_ID,
  });
});

test('deleteWebhook returns WEBHOOK_NOT_FOUND as a value', async () => {
  database.respondTo('delete', 'webhooks', rows());

  expect(expectErr(await asCaller(() => Services.deleteWebhook(WEBHOOK_ID)))).toEqual({
    code: 'WEBHOOK_NOT_FOUND',
    id: WEBHOOK_ID,
  });
});

// getWebhook

test('getWebhook returns Ok', async () => {
  database.respondTo('select', 'webhooks', rows(webhookRow()));

  const webhook = expectOk(await asCaller(() => Services.getWebhook(WEBHOOK_ID)));

  expect(webhook.id).toBe(WEBHOOK_ID);
  expect(webhook.endpoint).toBe('https://example.test/hook');

  // organization_id is not part of the response shape.
  expect(webhook).not.toHaveProperty('organization_id');
});

// Tenant scoping is deliberately NOT asserted here. The double answers with
// whatever response the test arranged, whatever the predicate said, so a passing
// assertion would prove nothing about the boundary. The
// `eq(organization_id)` in the query IS the boundary -
// so it is covered in tests/integration/webhooks.integration.test.ts against a
// real database instead.

test('getWebhook rejects when the query fails', async () => {
  database.respondTo('select', 'webhooks', failsWith(new Error('connection terminated')));

  await expect(asCaller(() => Services.getWebhook(WEBHOOK_ID))).rejects.toThrow('connection terminated');
});

test('getWebhook rejects when the row will not parse', async () => {
  database.respondTo('select', 'webhooks', rows({ id: 'not-a-uuid' }));

  await expect(asCaller(() => Services.getWebhook(WEBHOOK_ID))).rejects.toThrow();
});

// updateWebhook

test('updateWebhook returns Ok', async () => {
  database.respondTo('select', 'webhooks', rows(webhookRow()));
  database.respondTo('update', 'webhooks', rows(webhookRow({ name: 'renamed' })));

  const updated = expectOk(await asCaller(() => Services.updateWebhook(WEBHOOK_ID, { name: 'renamed' })));

  expect(updated.name).toBe('renamed');
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'webhooks.updated',
    target_type: 'webhook',
    target_id: WEBHOOK_ID,
    difference: { name: { old: 'deploys', new: 'renamed' } },
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('updateWebhook rejects when the update fails', async () => {
  database.respondTo('select', 'webhooks', rows(webhookRow()));
  database.respondTo('update', 'webhooks', failsWith(new Error('deadlock detected')));

  await expect(asCaller(() => Services.updateWebhook(WEBHOOK_ID, { name: 'renamed' }))).rejects.toThrow(
    'deadlock detected',
  );
});

// deleteWebhook

test('deleteWebhook returns Ok when a row was removed', async () => {
  database.respondTo('delete', 'webhooks', rows(webhookRow()));

  expect((await asCaller(() => Services.deleteWebhook(WEBHOOK_ID))).isOk()).toBe(true);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'webhooks.deleted',
    target_type: 'webhook',
    target_id: WEBHOOK_ID,
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('deleteWebhook rejects when the delete fails', async () => {
  database.respondTo('delete', 'webhooks', failsWith(new Error('connection terminated')));

  await expect(asCaller(() => Services.deleteWebhook(WEBHOOK_ID))).rejects.toThrow('connection terminated');
});

// The operations that stay plain promises

test('createWebhook stays a plain promise', async () => {
  database.respondTo('insert', 'webhooks', rows(webhookRow()));

  const created = await asCaller(() => Services.createWebhook({ name: 'deploys' } as CreateWebhookBody));

  // Deliberately not a Result: there is no expected failure to model.
  expect('isOk' in created).toBe(false);
  expect(created.id).toBe(WEBHOOK_ID);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'webhooks.created',
    target_type: 'webhook',
    target_id: WEBHOOK_ID,
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('createWebhook takes the organization and creator from the caller, not the body', async () => {
  database.respondTo('insert', 'webhooks', rows(webhookRow()));

  // Cast through unknown deliberately: these two fields are not part of the
  // body schema at all, which is the point - a client can still put them on the
  // wire, and the service must ignore them.
  await asCaller(() =>
    Services.createWebhook({
      name: 'deploys',
      endpoint: 'https://example.test/hook',
      organization_id: 'somebody-else',
      creator_id: 'somebody-else',
    } as unknown as CreateWebhookBody),
  );

  const insert = database.queriesFor('insert', 'webhooks')[0];
  const values = insert?.calls.find((call) => call.method === 'values')?.args[0] as Record<string, unknown>;

  expect(values.organization_id).toBe(ORGANIZATION_ID);
  expect(values.creator_id).toBe(USER_ID);
});

test('createWebhook rejects when the insert returns no row', async () => {
  database.respondTo('insert', 'webhooks', rows());

  await expect(asCaller(() => Services.createWebhook({ name: 'deploys' } as CreateWebhookBody))).rejects.toThrow(
    'Failed to create webhook',
  );
});

test('listWebhooks stays a plain promise', async () => {
  database.respondTo('select', 'webhooks', rows(webhookRow()));

  const page = await asCaller(() => Services.listWebhooks({ limit: 50 }));

  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
  expect(page.meta).toEqual({ oldest_id: WEBHOOK_ID, more_data: false });
});

test('submitWebhookRequest rejects rather than returning a failure', async () => {
  // Called by the delivery pipeline, not by a handler - there is no HTTP caller
  // to hand a refusal to, so an empty insert is a malfunction.
  database.respondTo('insert', 'webhook_outbox', rows());

  await expect(Services.submitWebhookRequest(WEBHOOK_ID, 'log-1')).rejects.toThrow('Failed to submit webhook request');
});
