import { beforeEach, expect, test } from 'bun:test';
import type { CreateApiKeyBody, UpdateApiKeyBody, UpdateApiKeyResponse } from '../../src/api/api-keys/api-keys.schemas';
import type { UpdateApiKeyFailure } from '../../src/api/api-keys/api-keys.services';
import {
  apiKeyRow,
  audit,
  cache,
  callerFixture,
  database,
  failsWith,
  installModuleMocks,
  KEY_ID,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk, type FailureCase } from './result';

// Must precede the imports below - both of them reach postgres and redis at
// module scope otherwise. Type-only imports above are erased, so they are safe
// to write statically.
await installModuleMocks();

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/api-keys/api-keys.services');
const { default: Schemas } = await import('../../src/api/api-keys/api-keys.schemas');

const OTHER_KEY_ID = '01912d3f-9b4a-7c3d-8e2f-000000000004';

beforeEach(() => {
  resetDoubles();
});

function update(body: UpdateApiKeyBody, id: string = KEY_ID) {
  return runWithCaller(callerFixture, () => Services.updateApiKey(id, body));
}

function create(body: CreateApiKeyBody) {
  return runWithCaller(callerFixture, () => Services.createApiKey(body));
}

function revoke(id: string = KEY_ID) {
  return runWithCaller(callerFixture, () => Services.revokeApiKey(id));
}

// --- updateApiKey: the shape of every expected failure -----------------------
//
// One scenario per declared code, checked against the union rather than a hand
// written list: adding a variant to UpdateApiKeyFailure without a scenario for
// it is a type error here.

function runUngrantableScopesScenario() {
  // No query is scripted: the refusal happens before any database work.
  return update({ scopes: 'api-keys:read admin:everything' });
}

function runMissingKeyScenario() {
  database.script(rows()); // select ... for update finds nothing

  return update({ name: 'renamed' });
}

function runRevokedKeyScenario() {
  database.script(rows(apiKeyRow({ revoked_at: new Date('2026-02-01T00:00:00.000Z') })));

  return update({ name: 'renamed' });
}

function runRateLimitWindowRequiredScenario() {
  // A key with neither set, patched to add a limit and nothing else.
  database.script(rows(apiKeyRow({ rate_limit_requests: null, rate_limit_window: null })));

  return update({ rate_limit_requests: 100 });
}

const updateFailureCases = {
  UNGRANTABLE_SCOPES: { run: runUngrantableScopesScenario },
  API_KEY_NOT_FOUND: { run: runMissingKeyScenario },
  API_KEY_REVOKED: { run: runRevokedKeyScenario },
  RATE_LIMIT_WINDOW_REQUIRED: { run: runRateLimitWindowRequiredScenario },
} satisfies Record<UpdateApiKeyFailure['code'], FailureCase<UpdateApiKeyResponse, UpdateApiKeyFailure>>;

for (const [code, scenario] of Object.entries(updateFailureCases)) {
  test(`updateApiKey returns ${code} as a value`, async () => {
    const failure = expectErr(await scenario.run());

    expect(failure.code).toBe(code as UpdateApiKeyFailure['code']);
  });
}

// --- updateApiKey ------------------------------------------------------------

test('updateApiKey returns Ok and audits the difference', async () => {
  const existing = apiKeyRow();
  database.script(rows(existing), rows(apiKeyRow({ name: 'renamed' })));

  const updated = expectOk(await update({ name: 'renamed' }));

  expect(updated.name).toBe('renamed');
  expect(database.transactions[0]?.committed).toBe(true);

  expect(audit.calls).toHaveLength(1);
  expect(audit.calls[0]?.transactional).toBe(true);
  expect(audit.calls[0]?.body).toMatchObject({
    event: 'api-keys.updated',
    status: 'success',
    target_id: KEY_ID,
    difference: { name: { old: 'ci', new: 'renamed' } },
  });
});

test('updateApiKey returns Ok for a no-op and writes nothing', async () => {
  // Only the select is scripted: an update would run off the end of the script
  // and reject, which is how this test knows one was not issued.
  database.script(rows(apiKeyRow()));

  const updated = expectOk(await update({ name: 'ci' }));

  expect(updated.id).toBe(KEY_ID);
  expect(audit.calls).toHaveLength(0);
});

test('updateApiKey reports the held and ungrantable scopes', async () => {
  const failure = expectErr(await update({ scopes: 'api-keys:read admin:everything' }));

  expect(failure).toEqual({
    code: 'UNGRANTABLE_SCOPES',
    held: ['api-keys:read', 'api-keys:write'],
    ungrantable: ['admin:everything'],
  });

  // The refusal is audited, under the caller's own event name.
  expect(audit.calls[0]?.body).toMatchObject({
    event: 'api-keys.updated',
    status: 'failure',
    metadata: { reason: 'ungrantable_scopes' },
  });
});

test('updateApiKey still refuses the scopes when the refusal audit fails', async () => {
  // The one swallowed audit failure in the module: a failed write ABOUT the
  // refusal must not replace the refusal itself.
  audit.failure = new Error('audit log unavailable');

  const failure = expectErr(await update({ scopes: 'admin:everything' }));

  expect(failure.code).toBe('UNGRANTABLE_SCOPES');
});

test('updateApiKey rejects when the select fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(update({ name: 'renamed' })).rejects.toThrow('connection terminated');
});

test('updateApiKey rejects when the update fails', async () => {
  database.script(rows(apiKeyRow()), failsWith(new Error('deadlock detected')));

  await expect(update({ name: 'renamed' })).rejects.toThrow('deadlock detected');
});

test('updateApiKey rejects when the update returns no row', async () => {
  database.script(rows(apiKeyRow()), rows());

  await expect(update({ name: 'renamed' })).rejects.toThrow('Failed to update API key');
});

test('updateApiKey rolls back when the success audit fails', async () => {
  database.script(rows(apiKeyRow()), rows(apiKeyRow({ name: 'renamed' })));
  audit.failure = new Error('audit log unavailable');

  await expect(update({ name: 'renamed' })).rejects.toThrow('audit log unavailable');

  // The audit entry and the row it describes commit together or not at all.
  expect(database.transactions[0]?.rolledBack).toBe(true);
});

test('updateApiKey allows a limit change on a key that already has a window', async () => {
  // The invariant is about the resulting row, not the body: raising the limit
  // without restating the window is a legitimate patch, and a body-local check
  // would have broken it.
  database.script(
    rows(apiKeyRow({ rate_limit_requests: 10, rate_limit_window: 60 })),
    rows(apiKeyRow({ rate_limit_requests: 100, rate_limit_window: 60 })),
  );

  const updated = expectOk(await update({ rate_limit_requests: 100 }));

  expect(updated.rate_limit_requests).toBe(100);
});

test('an unrelated patch on a key already missing its window is not blocked', async () => {
  // Rows stored before the API refused the combination still authenticate -
  // enforceKeyQuota defaults the missing window - so renaming one should not
  // fail as collateral. Only a patch that touches the rate limit is refused.
  database.script(
    rows(apiKeyRow({ rate_limit_requests: 100, rate_limit_window: null })),
    rows(apiKeyRow({ rate_limit_requests: 100, rate_limit_window: null, name: 'renamed' })),
  );

  expect(expectOk(await update({ name: 'renamed' })).name).toBe('renamed');
});

test('updateApiKey rejects when the response will not parse', async () => {
  database.script(rows(apiKeyRow()), rows({ id: 'not-a-uuid' }));

  await expect(update({ name: 'renamed' })).rejects.toThrow();
});

// --- createApiKey ------------------------------------------------------------

// --- the rate limit pair, at creation ----------------------------------------
//
// The create side is enforced by the body schema rather than the service, so it
// is checked here rather than through a scripted call. A limit with no window
// used to be accepted, stored as NULL, and then throw a TypeError inside
// authenticate() on every request the key made - bricking it permanently
// rather than leaving it unlimited.

test('a request limit without a window is refused at creation', () => {
  const parsed = Schemas.createApiKey.body.safeParse({ name: 'ci', rate_limit_requests: 100 });

  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.path).toEqual(['rate_limit_window']);
});

test('the pair is accepted when both halves are present', () => {
  expect(
    Schemas.createApiKey.body.safeParse({ name: 'ci', rate_limit_requests: 100, rate_limit_window: 60 }).success,
  ).toBe(true);
});

test('a key with no limit at all still needs no window', () => {
  // Unlimited is the ordinary case and must stay the easy one.
  expect(Schemas.createApiKey.body.safeParse({ name: 'ci' }).success).toBe(true);
});

test('createApiKey returns Ok with the plaintext key exactly once', async () => {
  database.script(rows(apiKeyRow()));

  const created = expectOk(await create({ name: 'ci' } as CreateApiKeyBody));

  expect(created.key).toMatch(/^aik_[0-9a-f]{60}$/);
  expect(audit.calls[0]?.body).toMatchObject({ event: 'api-keys.created', status: 'success' });
  expect(database.transactions[0]?.committed).toBe(true);
});

test('createApiKey does not leak a plaintext key on refusal', async () => {
  const failure = expectErr(await create({ name: 'ci', scopes: 'admin:everything' } as CreateApiKeyBody));

  expect(JSON.stringify(failure)).not.toContain('aik_');
  expect(failure).toEqual({
    code: 'UNGRANTABLE_SCOPES',
    held: ['api-keys:read', 'api-keys:write'],
    ungrantable: ['admin:everything'],
  });
});

test('createApiKey rejects when the insert fails', async () => {
  database.script(failsWith(new Error('unique violation')));

  await expect(create({ name: 'ci' } as CreateApiKeyBody)).rejects.toThrow('unique violation');
});

test('createApiKey rejects when the insert returns no row', async () => {
  database.script(rows());

  await expect(create({ name: 'ci' } as CreateApiKeyBody)).rejects.toThrow('Failed to insert API key');
});

test('createApiKey rolls back when the success audit fails', async () => {
  database.script(rows(apiKeyRow()));
  audit.failure = new Error('audit log unavailable');

  await create({ name: 'ci' } as CreateApiKeyBody).catch(() => {});

  expect(database.transactions[0]?.rolledBack).toBe(true);
});

// --- revokeApiKey ------------------------------------------------------------

test('revokeApiKey returns API_KEY_NOT_FOUND as a value', async () => {
  // The update matches nothing, and neither does the follow-up select.
  database.script(rows(), rows());

  expect(expectErr(await revoke())).toEqual({ code: 'API_KEY_NOT_FOUND', id: KEY_ID });
});

test('revokeApiKey returns Ok and records what changed', async () => {
  const revokedAt = new Date('2026-03-01T00:00:00.000Z');
  database.script(rows(apiKeyRow({ revoked_at: revokedAt, revoked_by: USER_ID })));

  expect((await revoke()).isOk()).toBe(true);

  expect(audit.calls[0]?.transactional).toBe(true);
  expect(audit.calls[0]?.body).toMatchObject({
    event: 'api-keys.revoked',
    status: 'success',
    difference: {
      revoked_at: { old: null, new: revokedAt },
      revoked_by: { old: null, new: USER_ID },
    },
  });
});

test('revokeApiKey is idempotent for an already revoked key', async () => {
  // No rows updated, but the key does exist - the current API answers 204 here
  // rather than a conflict, and that behavior is preserved.
  database.script(rows(), rows({ id: KEY_ID }));

  expect((await revoke()).isOk()).toBe(true);
  expect(audit.calls).toHaveLength(0);
});

test('revokeApiKey rejects when the update fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(revoke()).rejects.toThrow('connection terminated');
});

test('revokeApiKey rolls back when the success audit fails', async () => {
  database.script(rows(apiKeyRow({ revoked_at: new Date(), revoked_by: USER_ID })));
  audit.failure = new Error('audit log unavailable');

  await revoke().catch(() => {});

  expect(database.transactions[0]?.rolledBack).toBe(true);
});

// --- getApiKey ---------------------------------------------------------------

test('getApiKey returns API_KEY_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await Services.getApiKey(KEY_ID))).toEqual({ code: 'API_KEY_NOT_FOUND', id: KEY_ID });
});

test('getApiKey returns Ok without the secret columns', async () => {
  database.script(rows(apiKeyRow()));

  const key = expectOk(await Services.getApiKey(KEY_ID));

  expect(key.id).toBe(KEY_ID);
  expect(key).not.toHaveProperty('key_hash');
  expect(key).not.toHaveProperty('organization_id');
});

test('getApiKey rejects when the query fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(Services.getApiKey(KEY_ID)).rejects.toThrow('connection terminated');
});

test('getApiKey rejects when the row will not parse', async () => {
  database.script(rows({ id: KEY_ID, name: 42 }));

  await expect(Services.getApiKey(KEY_ID)).rejects.toThrow();
});

// --- getApiKeyStats ----------------------------------------------------------

test('getApiKeyStats returns API_KEY_NOT_FOUND as a value', async () => {
  // Postgres stays authoritative for whether the key exists; redis is never
  // consulted for that.
  database.script(rows());

  expect(expectErr(await Services.getApiKeyStats(KEY_ID))).toEqual({ code: 'API_KEY_NOT_FOUND', id: KEY_ID });
});

test('getApiKeyStats reads a never-used key as zero rather than missing', async () => {
  database.script(rows(apiKeyRow()));

  const stats = expectOk(await Services.getApiKeyStats(KEY_ID));

  expect(stats.total_requests).toBe(0);
  expect(stats.last_used_at).toBeNull();

  // No rate limit configured, so there is no window to report.
  expect(stats.current_window).toBeNull();
});

test('getApiKeyStats reports the open rate limit window', async () => {
  database.script(rows(apiKeyRow({ rate_limit_requests: 100 })));
  cache.usage[KEY_ID] = { total_requests: '42', last_used_at: '1767225600000' };
  cache.quota[KEY_ID] = { count: '7', pttl: 30_000 };

  const stats = expectOk(await Services.getApiKeyStats(KEY_ID));

  expect(stats.total_requests).toBe(42);
  expect(stats.last_used_at).toEqual(new Date(1767225600000));
  expect(stats.current_window).toMatchObject({ limit: 100, used: 7, remaining: 93 });
});

test('getApiKeyStats reports no window when nothing is counting down', async () => {
  database.script(rows(apiKeyRow({ rate_limit_requests: 100 })));

  // pTTL of -2: the counter expired or never existed, so nothing is being
  // limited right now.
  cache.quota[KEY_ID] = { count: null, pttl: -2 };

  const stats = expectOk(await Services.getApiKeyStats(KEY_ID));

  expect(stats.current_window).toBeNull();
});

test('getApiKeyStats rejects when redis fails rather than reporting zero usage', async () => {
  database.script(rows(apiKeyRow({ rate_limit_requests: 100 })));
  cache.failure = new Error('redis connection lost');

  await expect(Services.getApiKeyStats(KEY_ID)).rejects.toThrow('redis connection lost');
});

// --- listApiKeys -------------------------------------------------------------

test('listApiKeys stays a plain promise and hydrates usage counts', async () => {
  database.script(rows(apiKeyRow(), apiKeyRow({ id: OTHER_KEY_ID })));
  cache.usage[KEY_ID] = { total_requests: '9' };

  const page = await Services.listApiKeys({ limit: 50, status: 'all' });

  // Deliberately not a Result: there is no expected failure to model.
  expect('isOk' in page).toBe(false);

  expect(page.data.map((row) => row.total_requests)).toEqual([9, 0]);
  expect(page.meta).toEqual({ oldest_id: OTHER_KEY_ID, more_data: false });
});

test('listApiKeys rejects when the query fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(Services.listApiKeys({ limit: 50, status: 'all' })).rejects.toThrow('connection terminated');
});

// --- what the writes actually carry ------------------------------------------

test('createApiKey writes the caller context rather than the request body', async () => {
  database.script(rows(apiKeyRow()));

  // Row-level security is what enforces this at the database, but the service
  // must not hand it a tenant that the request body asked for.
  await create({ name: 'ci', organization_id: 'somebody-else' } as CreateApiKeyBody);

  const values = database.calls.find((call) => call.method === 'values')?.args[0] as Record<string, unknown>;

  expect(values.organization_id).toBe(ORGANIZATION_ID);
  expect(values.creator_id).toBe(USER_ID);

  // The plaintext never reaches the database, only its digest.
  expect(values.key_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(values).not.toHaveProperty('key');
});

test('updateApiKey writes only the fields the caller sent', async () => {
  database.script(rows(apiKeyRow()), rows(apiKeyRow({ name: 'renamed' })));

  await update({ name: 'renamed' });

  const set = database.calls.find((call) => call.method === 'set')?.args[0] as Record<string, unknown>;

  expect(set).toEqual({ name: 'renamed' });
});
