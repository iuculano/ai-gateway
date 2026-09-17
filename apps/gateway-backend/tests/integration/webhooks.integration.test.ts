// ./setup rewrites POSTGRES_CONNECTION_STRING and is loaded by --preload, so
// the order of these imports does not matter. See the test:integration script.
import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/webhooks/webhooks.services';
import { admin, callerFor, prepareSuite, readAuditRows, resetDatabase, seedTenant, type Tenant } from './setup';

// Real database tests cover tenant isolation and transaction rollback.

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();

  acme = await seedTenant('acme');
  globex = await seedTenant('globex');
});

function asCaller<T>(tenant: Tenant, work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFor(tenant, ['webhooks:read', 'webhooks:write']), work);
}

async function createWebhook(tenant: Tenant, name = 'deploys') {
  return asCaller(tenant, () => Services.createWebhook({ name, endpoint: 'https://example.test/hook' }));
}

async function readWebhookRow(id: string) {
  const [row] = await admin`select * from webhooks where id = ${id}`;

  return row;
}

test('creating a webhook assigns caller ownership and persists unset fields as null', async () => {
  const created = await createWebhook(acme);

  const row = await readWebhookRow(created.id);

  expect(row?.organization_id).toBe(acme.organizationId);
  expect(row?.creator_id).toBe(acme.userId);
  const fetched = (await asCaller(acme, () => Services.getWebhook(created.id)))._unsafeUnwrap();
  expect(fetched).toMatchObject({ description: null, filter: null, tags: null });
});

test('another organization cannot read the webhook', async () => {
  const created = await createWebhook(acme);

  const result = await asCaller(globex, () => Services.getWebhook(created.id));

  expect(result._unsafeUnwrapErr().code).toBe('WEBHOOK_NOT_FOUND');
});

test('another organization cannot update the webhook', async () => {
  const created = await createWebhook(acme);

  const result = await asCaller(globex, () => Services.updateWebhook(created.id, { name: 'stolen' }));

  expect(result._unsafeUnwrapErr().code).toBe('WEBHOOK_NOT_FOUND');

  // Refused, and the row is untouched rather than merely unreported.
  expect((await readWebhookRow(created.id))?.name).toBe('deploys');
});

test('another organization cannot delete the webhook', async () => {
  const created = await createWebhook(acme);

  const result = await asCaller(globex, () => Services.deleteWebhook(created.id));

  expect(result._unsafeUnwrapErr().code).toBe('WEBHOOK_NOT_FOUND');
  expect(await readWebhookRow(created.id)).toBeDefined();
});

test('the owner can update and delete it', async () => {
  const created = await createWebhook(acme);

  const updated = await asCaller(acme, () => Services.updateWebhook(created.id, { name: 'renamed' }));
  expect(updated._unsafeUnwrap().name).toBe('renamed');

  const deleted = await asCaller(acme, () => Services.deleteWebhook(created.id));
  expect(deleted.isOk()).toBe(true);
  expect(await readWebhookRow(created.id)).toBeUndefined();

  const audits = await readAuditRows(created.id);
  expect(audits.map((audit: { event: string }) => audit.event)).toEqual([
    'webhooks.created',
    'webhooks.updated',
    'webhooks.deleted',
  ]);
  expect(audits[1]?.difference).toEqual({ name: { old: 'deploys', new: 'renamed' } });
  expect((await asCaller(acme, () => Services.deleteWebhook(created.id)))._unsafeUnwrapErr().code).toBe(
    'WEBHOOK_NOT_FOUND',
  );
});

test('a failing webhook audit write rolls the update back', async () => {
  const created = await createWebhook(acme);

  await admin.unsafe(
    "alter table audit_logs add constraint audit_webhooks_integration_block check (event <> 'webhooks.updated')",
  );

  try {
    await expect(asCaller(acme, () => Services.updateWebhook(created.id, { name: 'renamed' }))).rejects.toThrow();
  } finally {
    await admin.unsafe('alter table audit_logs drop constraint audit_webhooks_integration_block');
  }

  expect((await readWebhookRow(created.id))?.name).toBe('deploys');
});

test('listing is scoped to the caller even when both organizations have webhooks', async () => {
  const mine = await createWebhook(acme, 'mine');
  await createWebhook(globex, 'theirs');

  const page = await asCaller(acme, () => Services.listWebhooks({ limit: 50 }));

  expect(page.data.map((row) => row.id)).toEqual([mine.id]);
});
