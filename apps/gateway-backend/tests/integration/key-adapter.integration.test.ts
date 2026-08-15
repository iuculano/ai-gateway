import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGenericKeyAdapter } from '@repo/auth';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/api-keys/api-keys.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

/**
 * The credential path, end to end.
 *
 * Everything else in the suite starts from a caller that already exists. This
 * is the code that makes one, including the system-scoped key lookup that
 * determines which tenant the rest of the request belongs to.
 */

const authenticate = createGenericKeyAdapter({ keyPattern: /^aik_[a-zA-Z0-9]{60}$/ });

let acme: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('acme');
});

async function issueKey(overrides: { scopes?: string; allowed_ips?: string[] } = {}) {
  const caller = callerFor(acme, ['api-keys:write', 'chat-completions:write']);

  const result = await runWithCaller(caller, () => Services.createApiKey({ name: 'ci', ...overrides }));

  if (result.isErr()) {
    throw new Error(`Failed to issue a key: ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

function authenticateKey(key: string, ipAddress = '127.0.0.1') {
  return authenticate({ key, request: { ipAddress } });
}

test('a valid key resolves to its organization, actor, and owner', async () => {
  const key = await issueKey({ scopes: 'chat-completions:write' });

  const caller = await authenticateKey(key.key);

  expect(caller.organization.id).toBe(acme.organizationId);
  expect(caller.actor.type).toBe('api_key');

  if (caller.actor.type !== 'api_key') {
    throw new Error('Expected an API key actor');
  }

  expect(caller.actor.owner.id).toBe(acme.userId);
  expect(caller.actor.key.id).toBe(key.id);
  expect(caller.permissions.scopes).toEqual(['chat-completions:write']);
});

test('a malformed key is rejected before any lookup', async () => {
  await expect(authenticateKey('not-a-key')).rejects.toMatchObject({ status: 401 });
});

test('an unknown key is rejected', async () => {
  await expect(authenticateKey(`aik_${'0'.repeat(60)}`)).rejects.toMatchObject({ status: 401 });
});

test('a revoked key is rejected', async () => {
  const key = await issueKey();
  await admin`update api_keys set revoked_at = now() where id = ${key.id}`;

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('an expired key is rejected', async () => {
  const key = await issueKey();
  await admin`update api_keys set expires_at = now() - interval '1 hour' where id = ${key.id}`;

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('a key whose creator was removed is rejected', async () => {
  const key = await issueKey();

  // creator_id is ON DELETE SET NULL, so the key outlives its owner as an
  // orphan. An orphaned key has nobody to attribute its actions to.
  await admin`update api_keys set creator_id = null where id = ${key.id}`;

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('deleting an owner invalidates a previously used key immediately', async () => {
  const key = await issueKey();

  await authenticateKey(key.key);
  await admin`update users set status = 'deleted' where id = ${acme.userId}`;

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('suspending an organization invalidates a previously used key immediately', async () => {
  const key = await issueKey();

  await authenticateKey(key.key);
  await admin`update organizations set status = 'suspended' where id = ${acme.organizationId}`;

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('an allowlisted IPv4 network accepts a matching peer', async () => {
  const key = await issueKey({ allowed_ips: ['192.0.2.0/24'] });

  const caller = await authenticateKey(key.key, '192.0.2.42');

  expect(caller.actor.type).toBe('api_key');
});

test('an IPv4 allowlist accepts an IPv4-mapped IPv6 peer', async () => {
  const key = await issueKey({ allowed_ips: ['192.0.2.0/24'] });

  const caller = await authenticateKey(key.key, '::ffff:192.0.2.42');

  expect(caller.actor.type).toBe('api_key');
});

test('an allowlisted IPv6 network accepts a matching peer', async () => {
  const key = await issueKey({ allowed_ips: ['2001:db8::/32'] });

  const caller = await authenticateKey(key.key, '2001:db8::42');

  expect(caller.actor.type).toBe('api_key');
});

test('an allowlisted key rejects a peer outside its networks', async () => {
  const key = await issueKey({ allowed_ips: ['192.0.2.0/24', '2001:db8::/32'] });

  await expect(authenticateKey(key.key, '198.51.100.10')).rejects.toMatchObject({ status: 401 });
});

test('an allowlisted key rejects a request with no peer address', async () => {
  const key = await issueKey({ allowed_ips: ['192.0.2.0/24'] });

  await expect(authenticate({ key: key.key, request: {} })).rejects.toMatchObject({ status: 401 });
});
