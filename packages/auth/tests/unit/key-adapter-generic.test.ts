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

const { createGenericKeyAdapter } = await import('../../src/adapters/key-adapter-generic');

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

describe('createGenericKeyAdapter', () => {
  test('rejects malformed keys before hashing, storage, or rate limiting', async () => {
    const error = await rejectedHttpException(authenticate('not-an-api-key'));

    expect(error.status).toBe(401);
    expect(error.cause).toBe('Invalid API key: malformed');
    expect(database.consumed).toBe(0);
    expect(quota.calls).toEqual([]);
    expect(usage.pipelines).toEqual([]);
  });

  test('rejects missing, revoked, expired, and orphaned keys', async () => {
    const cases = [
      { row: undefined, cause: 'Invalid API key: not found' },
      { row: apiKeyRow({ revoked_at: new Date() }), cause: 'Invalid API key: revoked' },
      { row: apiKeyRow({ expires_at: new Date(Date.now() - 1) }), cause: 'Invalid API key: expired' },
      { row: apiKeyRow({ creator_id: null }), cause: 'Invalid API key: creator not found (no owning user)' },
    ];

    for (const fixture of cases) {
      resetDoubles();
      database.script(fixture.row ? rows(fixture.row) : rows());
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
        steps: [rows(apiKeyRow()), rows()],
        cause: 'Invalid API key: organization not found',
      },
      {
        steps: [rows(apiKeyRow()), rows(organizationRow({ status: 'suspended' }))],
        cause: 'Invalid API key: organization is not active',
      },
      {
        steps: [rows(apiKeyRow()), rows(organizationRow()), rows()],
        cause: 'Invalid API key: creator not found',
      },
      {
        steps: [rows(apiKeyRow()), rows(organizationRow()), rows(userRow({ status: 'deleted' }))],
        cause: 'Invalid API key: creator is not active',
      },
    ];

    for (const fixture of cases) {
      resetDoubles();
      database.script(...fixture.steps);
      const error = await rejectedHttpException(authenticate());
      expect(error.status).toBe(401);
      expect(error.cause).toBe(fixture.cause);
      expect(quota.calls).toEqual([]);
      expect(usage.pipelines).toEqual([]);
    }
  });

  test('builds the API-key caller and records one successful use', async () => {
    database.script(
      rows(apiKeyRow({ scopes: 'logs:read  logs:write' })),
      rows(organizationRow()),
      rows(userRow({ email: null, name: null })),
    );

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
    expect(usage.pipelines).toEqual([
      [
        { method: 'hIncrBy', args: [`api-keys:usage:${KEY_ID}`, 'total_requests', 1] },
        { method: 'hSet', args: [`api-keys:usage:${KEY_ID}`, 'last_used_at', expect.any(Number)] },
      ],
    ]);
  });

  test('enforces a configured fixed-window quota before recording usage', async () => {
    database.script(
      rows(apiKeyRow({ rate_limit_requests: 25, rate_limit_window: 60 })),
      rows(organizationRow()),
      rows(userRow()),
    );
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
    database.script(
      rows(apiKeyRow({ rate_limit_requests: 2, rate_limit_window: 30 })),
      rows(organizationRow()),
      rows(userRow()),
    );
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
    database.script(rows(apiKeyRow({ allowed_ips: ['10.0.0.0/8'] })), rows(organizationRow()), rows(userRow()));

    await expect(authenticate()).resolves.toMatchObject({ actor: { type: 'api_key' } });
  });

  test('surfaces Redis failures and never misreports them as invalid credentials', async () => {
    const quotaFailure = new Error('quota Redis unavailable');
    database.script(
      rows(apiKeyRow({ rate_limit_requests: 2, rate_limit_window: 30 })),
      rows(organizationRow()),
      rows(userRow()),
    );
    quota.failure = quotaFailure;
    await expect(authenticate()).rejects.toBe(quotaFailure);
    expect(usage.pipelines).toEqual([]);

    resetDoubles();
    const usageFailure = new Error('usage Redis unavailable');
    database.script(rows(apiKeyRow()), rows(organizationRow()), rows(userRow()));
    usage.failure = usageFailure;
    await expect(authenticate()).rejects.toBe(usageFailure);
    expect(usage.pipelines).toHaveLength(1);
  });
});
