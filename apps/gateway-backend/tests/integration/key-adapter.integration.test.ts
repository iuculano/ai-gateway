import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGenericKeyAdapter } from '@repo/auth';
import { runWithCaller } from '@repo/hono';
import { redis } from '@repo/redis';
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

async function issueKey(overrides: { scopes?: string; rate_limit_requests?: number; rate_limit_window?: number } = {}) {
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

test('service revocation is authoritative on the next authentication', async () => {
  const key = await issueKey();
  await authenticateKey(key.key);

  const revoked = await runWithCaller(callerFor(acme, ['api-keys:write']), () => Services.revokeApiKey(key.id));
  expect(revoked.isOk()).toBe(true);

  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 401 });
});

test('scope updates are authoritative on the next authentication', async () => {
  const key = await issueKey({ scopes: 'chat-completions:write' });
  await expect(authenticateKey(key.key)).resolves.toMatchObject({
    permissions: { scopes: ['chat-completions:write'] },
  });

  const updated = await runWithCaller(callerFor(acme, ['api-keys:write', 'logs:read']), () =>
    Services.updateApiKey(key.id, { scopes: 'logs:read' }),
  );
  expect(updated.isOk()).toBe(true);

  await expect(authenticateKey(key.key)).resolves.toMatchObject({ permissions: { scopes: ['logs:read'] } });
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

test('successful authentication records usage that the API-key stats endpoint reports', async () => {
  const key = await issueKey();
  const startedAt = Date.now();

  await authenticateKey(key.key);
  await authenticateKey(key.key);

  const stats = await runWithCaller(callerFor(acme, ['api-keys:read']), () => Services.getApiKeyStats(key.id));
  const value = stats._unsafeUnwrap();

  expect(value.total_requests).toBe(2);
  expect(value.last_used_at?.getTime()).toBeGreaterThanOrEqual(startedAt);
  expect(value.current_window).toBeNull();
});

test('a limited key rejects excess authentication without recording it as successful usage', async () => {
  const key = await issueKey({ rate_limit_requests: 1, rate_limit_window: 60 });

  await authenticateKey(key.key);

  let failure: unknown;
  try {
    await authenticateKey(key.key);
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ status: 429 });
  const response = (failure as { res?: Response }).res;
  expect(response?.headers.get('Retry-After')).toMatch(/^\d+$/);
  expect(response?.headers.get('RateLimit-Policy')).toBe('1;w=60');
  expect(await redis.hGet(`api-keys:usage:${key.id}`, 'total_requests')).toBe('1');
});

test('updating a limited key resets its live window and the new policy takes effect', async () => {
  const key = await issueKey({ rate_limit_requests: 1, rate_limit_window: 60 });

  await authenticateKey(key.key);
  await expect(authenticateKey(key.key)).rejects.toMatchObject({ status: 429 });

  const updated = await runWithCaller(callerFor(acme, ['api-keys:write']), () =>
    Services.updateApiKey(key.id, { rate_limit_requests: 2 }),
  );
  expect(updated.isOk()).toBe(true);

  await expect(authenticateKey(key.key)).resolves.toMatchObject({ organization: { id: acme.organizationId } });
  expect(await redis.hGet(`api-keys:usage:${key.id}`, 'total_requests')).toBe('2');
});
