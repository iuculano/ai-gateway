// ./setup rewrites POSTGRES_CONNECTION_STRING and is loaded by --preload, so
// the order of these imports does not matter. See the test:integration script.
import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/api-keys/api-keys.services';
import {
  admin,
  callerFor,
  prepareSuite,
  readApiKeyRow,
  readAuditRows,
  resetDatabase,
  seedTenant,
  type Tenant,
} from './setup';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();

  acme = await seedTenant('acme');
  globex = await seedTenant('globex');
});

/**
 * Runs `work` as a caller from `tenant`.
 */
function asTenant<T>(tenant: Tenant, work: () => Promise<T>, scopes?: string[]): Promise<T> {
  return runWithCaller(callerFor(tenant, scopes ?? ['api-keys:read', 'api-keys:write']), work);
}

async function createKey(tenant: Tenant, name = 'ci') {
  const result = await asTenant(tenant, () => Services.createApiKey({ name }));

  if (result.isErr()) {
    throw new Error(`Failed to seed a key: ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

// --- tenant isolation --------------------------------------------------------
//
// These run against Postgres so the organization predicates are tested as
// emitted SQL rather than against a double that accepts every condition.

test('a key belongs to the organization that created it', async () => {
  const created = await createKey(acme);

  const row = await readApiKeyRow(created.id);

  expect(row?.organization_id).toBe(acme.organizationId);

  // The plaintext is returned once and never stored.
  expect(row?.key_hash).not.toBe(created.key);
  expect(row?.key_hash).toMatch(/^[0-9a-f]{64}$/);
});

test('another organization cannot read the key', async () => {
  const created = await createKey(acme);

  const result = await asTenant(globex, () => Services.getApiKey(created.id));

  // Not a distinct "belongs to someone else" answer - the row is simply not
  // there as far as this caller is concerned, and the API deliberately does
  // not distinguish that from a missing id.
  expect(result.isErr()).toBe(true);
  expect(result._unsafeUnwrapErr().code).toBe('API_KEY_NOT_FOUND');
});

test('another organization cannot list the key', async () => {
  await createKey(acme);

  const page = await asTenant(globex, () => Services.listApiKeys({ limit: 50, status: 'all' }));

  expect(page.data).toHaveLength(0);
});

test('another organization cannot update the key', async () => {
  const created = await createKey(acme);

  const result = await asTenant(globex, () => Services.updateApiKey(created.id, { name: 'stolen' }));

  expect(result._unsafeUnwrapErr().code).toBe('API_KEY_NOT_FOUND');

  // And the row is untouched, not merely unreported.
  expect((await readApiKeyRow(created.id))?.name).toBe('ci');
});

test('another organization cannot revoke the key', async () => {
  const created = await createKey(acme);

  const result = await asTenant(globex, () => Services.revokeApiKey(created.id));

  expect(result._unsafeUnwrapErr().code).toBe('API_KEY_NOT_FOUND');
  expect((await readApiKeyRow(created.id))?.revoked_at).toBeNull();
});

// --- transactions ------------------------------------------------------------

test('creation commits the key and its audit entry together', async () => {
  const created = await createKey(acme);

  const audits = await readAuditRows(created.id);

  expect(audits).toHaveLength(1);
  expect(audits[0]?.event).toBe('api-keys.created');
  expect(audits[0]?.status).toBe('success');
  expect(audits[0]?.actor_id).toBe(acme.userId);
});

test('a failing audit write rolls the update back', async () => {
  const created = await createKey(acme);

  // A constraint the audit insert cannot satisfy, imposed from outside the
  // application. Nothing about the update itself is wrong - which is the
  // point: the row must not survive an audit entry that did not.
  await admin.unsafe(
    "alter table audit_logs add constraint audit_logs_integration_block check (event <> 'api-keys.updated')",
  );

  try {
    await expect(asTenant(acme, () => Services.updateApiKey(created.id, { name: 'renamed' }))).rejects.toThrow();
  } finally {
    await admin.unsafe('alter table audit_logs drop constraint audit_logs_integration_block');
  }

  expect((await readApiKeyRow(created.id))?.name).toBe('ci');
});

test('revocation commits the row and its audit entry together', async () => {
  const created = await createKey(acme);

  const result = await asTenant(acme, () => Services.revokeApiKey(created.id));
  expect(result.isOk()).toBe(true);

  const row = await readApiKeyRow(created.id);
  expect(row?.revoked_at).not.toBeNull();
  expect(row?.revoked_by).toBe(acme.userId);

  const audits = await readAuditRows(created.id);
  expect(audits.map((audit: { event: string }) => audit.event)).toEqual(['api-keys.created', 'api-keys.revoked']);
});

test('revoking twice is idempotent and audits once', async () => {
  const created = await createKey(acme);

  const first = await asTenant(acme, () => Services.revokeApiKey(created.id));
  const revokedAt = (await readApiKeyRow(created.id))?.revoked_at;

  const second = await asTenant(acme, () => Services.revokeApiKey(created.id));

  expect(first.isOk()).toBe(true);
  expect(second.isOk()).toBe(true);

  // The second call must not re-stamp the timestamp: the isNull(revoked_at)
  // predicate is what makes the update match nothing the second time.
  expect((await readApiKeyRow(created.id))?.revoked_at).toEqual(revokedAt);
  expect(await readAuditRows(created.id)).toHaveLength(2); // created + one revoke
});

// --- the SQL itself ----------------------------------------------------------

test('updating a revoked key is refused', async () => {
  const created = await createKey(acme);
  await asTenant(acme, () => Services.revokeApiKey(created.id));

  const result = await asTenant(acme, () => Services.updateApiKey(created.id, { name: 'renamed' }));

  expect(result._unsafeUnwrapErr().code).toBe('API_KEY_REVOKED');
});

test('a no-op update writes no audit entry', async () => {
  const created = await createKey(acme);

  const result = await asTenant(acme, () => Services.updateApiKey(created.id, { name: 'ci' }));

  expect(result.isOk()).toBe(true);
  expect(await readAuditRows(created.id)).toHaveLength(1); // creation only
});

test('an update records the before and after values', async () => {
  const created = await createKey(acme);

  await asTenant(acme, () => Services.updateApiKey(created.id, { name: 'renamed' }));

  const audits = await readAuditRows(created.id);
  const update = audits.find((audit: { event: string }) => audit.event === 'api-keys.updated');

  expect(update?.difference).toEqual({ name: { old: 'ci', new: 'renamed' } });
  expect((await readApiKeyRow(created.id))?.name).toBe('renamed');
});

test('the active filter excludes revoked keys', async () => {
  const kept = await createKey(acme, 'kept');
  const revoked = await createKey(acme, 'revoked');
  await asTenant(acme, () => Services.revokeApiKey(revoked.id));

  const all = await asTenant(acme, () => Services.listApiKeys({ limit: 50, status: 'all' }));
  const active = await asTenant(acme, () => Services.listApiKeys({ limit: 50, status: 'active' }));

  expect(all.data).toHaveLength(2);
  expect(active.data.map((row) => row.id)).toEqual([kept.id]);
});

test('the cursor walks the whole set exactly once', async () => {
  const created = [await createKey(acme, 'one'), await createKey(acme, 'two'), await createKey(acme, 'three')];

  const first = await asTenant(acme, () => Services.listApiKeys({ limit: 2, status: 'all' }));
  expect(first.data).toHaveLength(2);
  expect(first.meta.more_data).toBe(true);

  const second = await asTenant(acme, () =>
    Services.listApiKeys({ limit: 2, status: 'all', after_id: first.meta.oldest_id ?? undefined }),
  );

  expect(second.data).toHaveLength(1);
  expect(second.meta.more_data).toBe(false);

  // Newest first, and every key seen once.
  const seen = [...first.data, ...second.data].map((row) => row.id);
  expect(seen).toEqual(created.map((key) => key.id).reverse());
});

test('a caller cannot grant scopes it does not hold', async () => {
  const result = await asTenant(acme, () => Services.createApiKey({ name: 'escalated', scopes: 'admin:everything' }), [
    'api-keys:write',
  ]);

  expect(result._unsafeUnwrapErr().code).toBe('UNGRANTABLE_SCOPES');

  // The refusal is audited even though nothing was created, and the audit
  // write is what survives here - it is outside the transaction.
  const [audit] = await admin`select * from audit_logs where event = 'api-keys.created' and status = 'failure'`;
  expect(audit?.metadata).toMatchObject({ reason: 'ungrantable_scopes' });

  const rows = await asTenant(acme, () => Services.listApiKeys({ limit: 50, status: 'all' }));
  expect(rows.data).toHaveLength(0);
});
