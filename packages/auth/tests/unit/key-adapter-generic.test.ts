import { beforeEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import {
  apiKeyRow,
  database,
  installAuthMocks,
  KEY_ID,
  organizationRow,
  quota,
  resetDoubles,
  rows,
  usage,
  userRow,
} from './doubles';

await installAuthMocks();

const { createGenericKeyAdapter } = await import('../../index');

const VALID_KEY = `aik_${'A'.repeat(60)}`;

beforeEach(resetDoubles);

async function rejectedHttpException(promise: Promise<unknown>): Promise<HTTPException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPException) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected the adapter to reject with HTTPException');
}

function authenticate(key = VALID_KEY) {
  return createGenericKeyAdapter()({ key, request: { ipAddress: '203.0.113.8' } });
}

interface KeyLookup {
  key: ReturnType<typeof apiKeyRow> | null;
  organization?: ReturnType<typeof organizationRow> | null;
  owner?: ReturnType<typeof userRow> | null;
}

function arrangeKeyLookup(lookup: KeyLookup): void {
  const { key } = lookup;
  const organization = lookup.organization === undefined ? organizationRow() : lookup.organization;
  if (!key || !organization) {
    database.respondTo('select', 'api_keys', rows());
    return;
  }

  const owner = lookup.owner === undefined ? (key.creator_id ? userRow() : null) : lookup.owner;
  database.respondTo(
    'select',
    'api_keys',
    rows({
      apiKey: {
        id: key.id,
        organizationId: key.organization_id,
        name: key.name,
        creatorId: key.creator_id,
        scopes: key.scopes,
        rateLimitRequests: key.rate_limit_requests,
        rateLimitWindow: key.rate_limit_window,
        expiresAt: key.expires_at,
        revokedAt: key.revoked_at,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        status: organization.status,
      },
      owner:
        owner === null
          ? null
          : {
              id: owner.id,
              username: owner.username,
              email: owner.email,
              displayName: owner.name,
              status: owner.status,
            },
    }),
  );
}

describe('createGenericKeyAdapter', () => {
  test('rejects malformed keys before hashing, storage, or rate limiting', async () => {
    const error = await rejectedHttpException(authenticate('not-an-api-key'));

    expect(error.status).toBe(401);
    expect(error.cause).toBe('Invalid API key: malformed');
    expect(database.queries).toHaveLength(0);
    expect(quota.calls).toEqual([]);
    expect(usage.pipelines).toEqual([]);
  });

  test('rejects missing, revoked, expired, and orphaned keys', async () => {
    const cases = [
      { row: null, cause: 'Invalid API key: not found' },
      { row: apiKeyRow({ revoked_at: new Date() }), cause: 'Invalid API key: revoked' },
      { row: apiKeyRow({ expires_at: new Date(Date.now() - 1) }), cause: 'Invalid API key: expired' },
      { row: apiKeyRow({ creator_id: null }), cause: 'Invalid API key: creator not found (no owning user)' },
    ];

    for (const fixture of cases) {
      resetDoubles();
      arrangeKeyLookup({ key: fixture.row });
      const error = await rejectedHttpException(authenticate());
      expect(error.status).toBe(401);
      expect(error.cause).toBe(fixture.cause);
      expect(quota.calls).toEqual([]);
      expect(usage.pipelines).toEqual([]);
    }
  });

  test('checks fresh organization and owner status before quota or usage side effects', async () => {
    const cases = [
      {
        lookup: { key: apiKeyRow(), organization: null },
        cause: 'Invalid API key: not found',
      },
      {
        lookup: { key: apiKeyRow(), organization: organizationRow({ status: 'suspended' }) },
        cause: 'Invalid API key: organization is not active',
      },
      {
        lookup: { key: apiKeyRow(), organization: organizationRow(), owner: null },
        cause: 'Invalid API key: creator not found',
      },
      {
        lookup: { key: apiKeyRow(), organization: organizationRow(), owner: userRow({ status: 'deleted' }) },
        cause: 'Invalid API key: creator is not active',
      },
    ];

    for (const fixture of cases) {
      resetDoubles();
      arrangeKeyLookup(fixture.lookup);
      const error = await rejectedHttpException(authenticate());
      expect(error.status).toBe(401);
      expect(error.cause).toBe(fixture.cause);
      expect(quota.calls).toEqual([]);
      expect(usage.pipelines).toEqual([]);
    }
  });

  test('builds the API-key caller and records one successful use', async () => {
    arrangeKeyLookup({
      key: apiKeyRow({ scopes: 'logs:read  logs:write' }),
      organization: organizationRow(),
      owner: userRow({ email: null, name: null }),
    });

    const caller = await authenticate();

    expect(caller).toEqual({
      organization: { id: organizationRow().id, name: 'Acme' },
      actor: {
        type: 'api_key',
        key: { id: KEY_ID, name: 'automation' },
        owner: {
          id: userRow().id,
          username: 'alex',
          email: 'alex',
          displayName: undefined,
        },
      },
      permissions: { scopes: ['logs:read', 'logs:write'] },
    });
    expect(quota.calls).toEqual([]);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.calls.map((call) => call.method)).toEqual([
      'select',
      'from',
      'innerJoin',
      'leftJoin',
      'where',
    ]);
    expect(usage.pipelines).toEqual([
      [
        { method: 'hIncrBy', args: [`api-keys:usage:${KEY_ID}`, 'total_requests', 1] },
        { method: 'hSet', args: [`api-keys:usage:${KEY_ID}`, 'last_used_at', expect.any(Number)] },
      ],
    ]);
  });

  test('enforces a configured fixed-window quota before recording usage', async () => {
    arrangeKeyLookup({
      key: apiKeyRow({ rate_limit_requests: 25, rate_limit_window: 60 }),
      organization: organizationRow(),
      owner: userRow(),
    });
    quota.response = {
      limit: 25,
      isLimited: false,
      remainingQuota: 24,
      retryAfterSeconds: null,
      delaySeconds: null,
    };

    await authenticate();

    expect(quota.calls).toEqual([
      {
        key: `api-keys:quota:${KEY_ID}`,
        policy: { limit: 25, windowSeconds: 60 },
      },
    ]);
    expect(usage.pipelines).toHaveLength(1);
  });

  test('returns standard limit headers and does not record rejected attempts', async () => {
    arrangeKeyLookup({
      key: apiKeyRow({ rate_limit_requests: 2, rate_limit_window: 30 }),
      organization: organizationRow(),
      owner: userRow(),
    });
    quota.response = {
      limit: 2,
      isLimited: true,
      remainingQuota: 0,
      retryAfterSeconds: 17,
      delaySeconds: null,
    };

    const error = await rejectedHttpException(authenticate());
    const response = error.getResponse();

    expect(error.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(response.headers.get('RateLimit')).toBe('limit=2, remaining=0, reset=17');
    expect(response.headers.get('RateLimit-Policy')).toBe('2;w=30');
    expect(usage.pipelines).toEqual([]);
  });

  test('treats allowed_ips as reserved configuration until allowlisting is implemented', async () => {
    arrangeKeyLookup({
      key: apiKeyRow({ allowed_ips: ['10.0.0.0/8'] }),
      organization: organizationRow(),
      owner: userRow(),
    });

    await expect(authenticate()).resolves.toMatchObject({ actor: { type: 'api_key' } });
  });

  test('surfaces Redis failures and never misreports them as invalid credentials', async () => {
    const quotaFailure = new Error('quota Redis unavailable');
    arrangeKeyLookup({
      key: apiKeyRow({ rate_limit_requests: 2, rate_limit_window: 30 }),
      organization: organizationRow(),
      owner: userRow(),
    });
    quota.failure = quotaFailure;
    await expect(authenticate()).rejects.toBe(quotaFailure);
    expect(usage.pipelines).toEqual([]);

    resetDoubles();
    const usageFailure = new Error('usage Redis unavailable');
    arrangeKeyLookup({ key: apiKeyRow(), organization: organizationRow(), owner: userRow() });
    usage.failure = usageFailure;
    await expect(authenticate()).rejects.toBe(usageFailure);
    expect(usage.pipelines).toHaveLength(1);
  });
});
