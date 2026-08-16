import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { database, installAuthMocks, ORGANIZATION_ID, organizationRow, resetDoubles, rows, USER_ID } from './doubles';

await installAuthMocks();

const { createZitadelAdapter } = await import('../../src/adapters/jwt-adapter-zitadel');

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

async function adapter() {
  return createZitadelAdapter({
    issuer,
    audience: AUDIENCE,
    roleScopesMap: {
      admin: ['logs:write', 'logs:read'],
      viewer: ['logs:read'],
    },
  });
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
  test('verifies a real JWT and resolves a complete caller with deduplicated token-role grants', async () => {
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
    database.script(rows({ id: USER_ID, status: 'active' }), rows(organizationRow()));

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
      permissions: { scopes: ['openid', 'logs:read', 'logs:write'] },
    });
    expect(database.consumed).toBe(2);
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
    database.script(rows({ id: USER_ID, status: 'active' }), rows(organizationRow()));

    const authenticate = await adapter();
    const caller = await authenticate({ token, request: {} });

    expect(caller.permissions.scopes).toEqual(['openid', 'logs:read']);
    expect(caller.actor).toMatchObject({
      user: { email: 'alex', displayName: undefined, firstName: undefined, lastName: undefined },
    });
  });

  test('rejects missing or mistyped tenant and subject claims before identity lookups', async () => {
    const invalidTokens = [
      await tokenFor({}, { subject: 'external-user-1' }),
      await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' }, { subject: undefined }),
      await tokenFor({ [ORGANIZATION_ID_CLAIM]: 42 }, { subject: 'external-user-1' }),
    ];
    const authenticate = await adapter();

    for (const token of invalidTokens) {
      const error = await rejectedHttpException(authenticate({ token, request: {} }));
      expect(error.status).toBe(401);
      expect(error.cause).toBe('Invalid token: missing required claims');
    }
    expect(database.consumed).toBe(0);
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
    expect(database.consumed).toBe(0);
  });

  test('rejects userinfo without a string username and safely falls back from invalid optional profile fields', async () => {
    const invalidToken = await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' });
    userInfoByToken.set(invalidToken, {
      sub: 'external-user-1',
      preferred_username: 42,
    });
    const authenticate = await adapter();
    const invalidError = await rejectedHttpException(authenticate({ token: invalidToken, request: {} }));
    expect(invalidError.status).toBe(500);
    expect(invalidError.cause).toBe('Userinfo response: missing required claims');

    const fallbackToken = await tokenFor({ [ORGANIZATION_ID_CLAIM]: 'external-tenant-1' });
    userInfoByToken.set(fallbackToken, {
      sub: 'external-user-1',
      preferred_username: 'alex',
      email: 42,
      name: false,
      given_name: {},
      family_name: [],
    });
    database.script(rows({ id: USER_ID, status: 'active' }), rows(organizationRow()));
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
    expect(database.consumed).toBe(0);
  });
});
