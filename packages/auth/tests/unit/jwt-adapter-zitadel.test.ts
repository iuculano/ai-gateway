import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { database, installAuthMocks, ORGANIZATION_ID, organizationRow, resetDoubles, rows, USER_ID } from './doubles';

await installAuthMocks();

const { createZitadelAdapter } = await import('../../index');

const ORGANIZATION_ID_CLAIM = 'urn:zitadel:iam:user:resourceowner:id';
const ORGANIZATION_NAME_CLAIM = 'urn:zitadel:iam:user:resourceowner:name';
const ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';
const AUDIENCE = 'gateway';

const { privateKey, publicKey } = await generateKeyPair('ES256');
const publicJwk = await exportJWK(publicKey);
publicJwk.alg = 'ES256';
publicJwk.kid = 'auth-adapter-test';
publicJwk.use = 'sig';

const userInfoByToken = new Map<string, Record<string, unknown>>();
let issuer = '';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url.pathname === '/jwks') {
      return Response.json({ keys: [publicJwk] });
    }
    if (url.pathname === '/userinfo') {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      const userInfo = userInfoByToken.get(token);
      return userInfo ? Response.json(userInfo) : new Response(null, { status: 401 });
    }
    return new Response(null, { status: 404 });
  },
});
issuer = server.url.origin;

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  resetDoubles();
  userInfoByToken.clear();
});

async function tokenFor(
  claims: Record<string, unknown>,
  options: { subject?: string; audience?: string } = { subject: 'external-user-1' },
): Promise<string> {
  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
    .setIssuer(issuer)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m');

  if (options.subject !== undefined) {
    token = token.setSubject(options.subject);
  }

  return token.sign(privateKey);
}

async function adapter(
  roleScopesMap: Record<string, string[]> = { admin: ['logs:write', 'logs:read'], viewer: ['logs:read'] },
) {
  return createZitadelAdapter({
    issuer,
    audience: AUDIENCE,
    roleScopesMap,
  });
}

function arrangeActiveIdentity(): void {
  database.respondTo('select', 'user_identities', rows({ id: USER_ID, status: 'active' }));
  database.respondTo('select', 'organizations', rows(organizationRow()));
}

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

describe('createZitadelAdapter', () => {
  test('verifies a real JWT and resolves a complete caller from its role grants', async () => {
    const token = await tokenFor({
      scope: 'openid logs:read',
      [ORGANIZATION_ID_CLAIM]: 'external-tenant-1',
      [ORGANIZATION_NAME_CLAIM]: 'Acme from Zitadel',
      [ROLES_CLAIM]: { admin: { 'external-tenant-1': issuer } },
    });
    userInfoByToken.set(token, {
      sub: 'external-user-1',
      preferred_username: 'alex',
      email: 'alex@example.test',
      name: 'Alex Example',
      given_name: 'Alex',
      family_name: 'Example',
      [ROLES_CLAIM]: ['viewer'],
    });
    arrangeActiveIdentity();

    const authenticate = await adapter();
    const caller = await authenticate({ token, request: {} });

    expect(caller).toEqual({
      organization: { id: ORGANIZATION_ID, name: 'Acme' },
      actor: {
        type: 'user',
        user: {
          id: USER_ID,
          username: 'alex',
          email: 'alex@example.test',
          displayName: 'Alex Example',
          firstName: 'Alex',
          lastName: 'Example',
        },
      },
      permissions: { scopes: ['logs:write', 'logs:read'] },
    });
    expect(database.queries).toHaveLength(2);
  });

  test('falls back to userinfo roles when the access token carries none', async () => {
    const token = await tokenFor({
      scope: 'openid',
      [ORGANIZATION_ID_CLAIM]: 'external-tenant-1',
    });
    userInfoByToken.set(token, {
      sub: 'external-user-1',
      preferred_username: 'alex',
      [ROLES_CLAIM]: ['viewer'],
    });
    arrangeActiveIdentity();

    const authenticate = await adapter();
    const caller = await authenticate({ token, request: {} });

    expect(caller.permissions.scopes).toEqual(['logs:read']);
    expect(caller.actor).toMatchObject({
      user: { email: 'alex', displayName: undefined, firstName: undefined, lastName: undefined },
    });
  });

  // The regression guard for a token asserting its own permissions. The scope
  // claim mirrors the authorization request, and the browser client is public,
  // so a scope a role did not grant must never reach the Caller.
  test('ignores the token scope claim entirely while a role mapping is configured', async () => {
    const token = await tokenFor({
      scope: 'openid api-keys:write logs:write',
      [ORGANIZATION_ID_CLAIM]: 'external-tenant-1',
      [ROLES_CLAIM]: { viewer: { 'external-tenant-1': issuer } },
    });
    userInfoByToken.set(token, {
      sub: 'external-user-1',
      preferred_username: 'alex',
    });
    arrangeActiveIdentity();

    const authenticate = await adapter();
    const caller = await authenticate({ token, request: {} });

    // `viewer` grants logs:read and nothing else.
    expect(caller.permissions.scopes).toEqual(['logs:read']);
    expect(caller.permissions.scopes).not.toContain('api-keys:write');
    expect(caller.permissions.scopes).not.toContain('logs:write');
  });

  test("grants nothing when a configured mapping does not cover the caller's roles", async () => {
    const token = await tokenFor({
      scope: 'openid logs:write',
      [ORGANIZATION_ID_CLAIM]: 'external-tenant-1',
      [ROLES_CLAIM]: { unmapped: { 'external-tenant-1': issuer } },
    });
    userInfoByToken.set(token, {
      sub: 'external-user-1',
      preferred_username: 'alex',
    });
    arrangeActiveIdentity();

    const authenticate = await adapter();
    const caller = await authenticate({ token, request: {} });

    expect(caller.permissions.scopes).toEqual([]);
  });

  test('falls back to the token scope claim only when the mapping is empty', async () => {
    const token = await tokenFor({
      scope: 'openid logs:read',
      [ORGANIZATION_ID_CLAIM]: 'external-tenant-1',
      [ROLES_CLAIM]: { admin: { 'external-tenant-1': issuer } },
    });
    userInfoByToken.set(token, {
      sub: 'external-user-1',
      preferred_username: 'alex',
    });
    arrangeActiveIdentity();

    const authenticate = await adapter({});
    const caller = await authenticate({ token, request: {} });

    expect(caller.permissions.scopes).toEqual(['openid', 'logs:read']);
  });

  test('rejects missing tenant and subject claims before identity lookups', async () => {
    const invalidTokens = [
      await tokenFor({}, { subject: 'external-user-1' }),
      await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' }, { subject: undefined }),
    ];
    const authenticate = await adapter();

    for (const token of invalidTokens) {
      const error = await rejectedHttpException(authenticate({ token, request: {} }));
      expect(error.status).toBe(401);
      expect(error.cause).toBe('Invalid token: missing required claims');
    }
    expect(database.queries).toHaveLength(0);
  });

  test('rejects userinfo belonging to a different subject', async () => {
    const token = await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' });
    userInfoByToken.set(token, {
      sub: 'somebody-else',
      preferred_username: 'alex',
    });

    const authenticate = await adapter();
    const error = await rejectedHttpException(authenticate({ token, request: {} }));

    expect(error.status).toBe(401);
    expect(error.cause).toBe('Invalid token: userinfo subject does not match token subject');
    expect(database.queries).toHaveLength(0);
  });

  test('rejects userinfo without a username and falls back when optional profile fields are absent', async () => {
    const invalidToken = await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' });
    userInfoByToken.set(invalidToken, {
      sub: 'external-user-1',
    });
    const authenticate = await adapter();
    const invalidError = await rejectedHttpException(authenticate({ token: invalidToken, request: {} }));
    expect(invalidError.status).toBe(500);
    expect(invalidError.cause).toBe('Userinfo response: missing required claims');

    const fallbackToken = await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' });
    userInfoByToken.set(fallbackToken, {
      sub: 'external-user-1',
      preferred_username: 'alex',
    });
    arrangeActiveIdentity();
    const caller = await authenticate({ token: fallbackToken, request: {} });
    expect(caller.actor).toMatchObject({
      user: {
        email: 'alex',
        displayName: undefined,
        firstName: undefined,
        lastName: undefined,
      },
    });
  });

  test('rejects a token for another audience before userinfo or database access', async () => {
    const token = await tokenFor(
      { [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' },
      { subject: 'external-user-1', audience: 'some-other-service' },
    );
    const authenticate = await adapter();

    const error = await rejectedHttpException(authenticate({ token, request: {} }));

    expect(error.status).toBe(401);
    expect(String(error.cause)).toContain('Invalid token:');
    expect(database.queries).toHaveLength(0);
  });
});
