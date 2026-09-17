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
const { default: Services } = await import('../../src/api/webhooks/webhooks.services');

beforeEach(() => {
  resetDoubles();
});

function asCaller<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFixture, work);
}

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

// Tenant isolation and transaction rollback are covered by integration tests.

test('getWebhook rejects when the query fails', async () => {
  database.respondTo('select', 'webhooks', failsWith(new Error('connection terminated')));

  await expect(asCaller(() => Services.getWebhook(WEBHOOK_ID))).rejects.toThrow('connection terminated');
});

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

test('createWebhook uses caller ownership and records its audit in the transaction', async () => {
  database.respondTo('insert', 'webhooks', rows(webhookRow()));

  // Bypass request parsing to verify the service assigns caller ownership.
  const created = await asCaller(() =>
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
  expect(created.id).toBe(WEBHOOK_ID);
  expect(auditWrites.calls[0]?.body).toMatchObject({
    event: 'webhooks.created',
    target_type: 'webhook',
    target_id: WEBHOOK_ID,
  });
  expect(auditWrites.calls[0]?.transactional).toBe(true);
});

test('webhook responses preserve null fields and dates without exposing organization_id', async () => {
  database.respondTo(
    'select',
    'webhooks',
    rows(
      webhookRow({
        creator_id: null,
        description: null,
        filter: null,
        tags: null,
      }),
    ),
  );

  const webhook = expectOk(await asCaller(() => Services.getWebhook(WEBHOOK_ID)));
  expect(webhook).toMatchObject({ creator_id: null, description: null, filter: null, tags: null });
  expect(webhook.created_at).toBeInstanceOf(Date);
  expect(webhook).not.toHaveProperty('organization_id');
});

test('webhook write schemas keep omission distinct from clearing and exclude managed fields', async () => {
  const { default: schemas } = await import('../../src/api/webhooks/webhooks.schemas');
  const body = { name: 'Example', endpoint: 'https://example.test/hook' };
  expect(schemas.createWebhook.body.parse({ ...body, organization_id: ORGANIZATION_ID, creator_id: USER_ID })).toEqual(
    body,
  );
  expect(schemas.updateWebhook.body.parse({})).toEqual({});
  expect(schemas.updateWebhook.body.parse({ description: null, filter: null, tags: null })).toEqual({
    description: null,
    filter: null,
    tags: null,
  });
  expect(schemas.updateWebhook.body.safeParse({ tags: { invalid: 123 } }).success).toBe(false);
});
