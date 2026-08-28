import { afterEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fetchUserInfo, loadOpenIDProvider, verifyAccessToken } from '../../index';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function rejectedHttpException(promise: Promise<unknown>): Promise<HTTPException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPException) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected the operation to reject with HTTPException');
}

function stubFetch(handler: (request: Request) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return handler(request);
  }) as typeof fetch;
}

describe('loadOpenIDProvider', () => {
  test('loads a valid discovery document and constructs its JWKS resolver', async () => {
    const issuer = 'https://issuer.example';
    const requests: string[] = [];
    stubFetch((request) => {
      requests.push(request.url);
      return Response.json({
        issuer,
        userinfo_endpoint: `${issuer}/oidc/v1/userinfo`,
        jwks_uri: `${issuer}/oauth/v2/keys`,
      });
    });

    const provider = await loadOpenIDProvider(issuer);

    expect(requests).toEqual([`${issuer}/.well-known/openid-configuration`]);
    expect(provider.issuer).toBe(issuer);
    expect(provider.userinfoUri).toBe(`${issuer}/oidc/v1/userinfo`);
    expect(provider.jwkSet).toBeFunction();
  });

  test('classifies an unavailable discovery endpoint as an internal authentication failure', async () => {
    stubFetch(() => new Response(null, { status: 503 }));

    const error = await rejectedHttpException(loadOpenIDProvider('https://unavailable.example'));

    expect(error.status).toBe(500);
    expect(error.message).toBe('Failed to fetch OpenID configuration.');
  });

  test('rejects discovery documents missing any required endpoint', async () => {
    const issuer = 'https://issuer.example';
    for (const body of [
      { userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks` },
      { issuer, jwks_uri: `${issuer}/jwks` },
      { issuer, userinfo_endpoint: `${issuer}/userinfo` },
    ]) {
      stubFetch(() => Response.json(body));
      const error = await rejectedHttpException(loadOpenIDProvider(issuer));
      expect(error.status).toBe(500);
      expect(error.message).toBe('OpenID configuration missing required fields.');
    }
  });

  test('rejects discovery metadata that identifies a different issuer', async () => {
    stubFetch(() =>
      Response.json({
        issuer: 'https://impostor.example',
        userinfo_endpoint: 'https://issuer.example/userinfo',
        jwks_uri: 'https://issuer.example/jwks',
      }),
    );

    const error = await rejectedHttpException(loadOpenIDProvider('https://issuer.example'));

    expect(error.status).toBe(500);
    expect(error.message).toBe('OpenID configuration issuer does not match.');
  });
});

describe('fetchUserInfo', () => {
  test('authenticates the userinfo request and caches its response by hashed token', async () => {
    const token = `userinfo-${crypto.randomUUID()}`;
    const requests: Request[] = [];
    stubFetch((request) => {
      requests.push(request);
      return Response.json({ sub: 'user-1', preferred_username: 'alex' });
    });

    const first = await fetchUserInfo(token, 'https://issuer.example/userinfo');
    const second = await fetchUserInfo(token, 'https://unused.example/userinfo');

    expect(first).toEqual({ sub: 'user-1', preferred_username: 'alex' });
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://issuer.example/userinfo');
    expect(requests[0]?.headers.get('Authorization')).toBe(`Bearer ${token}`);
  });

  test('does not cache an unsuccessful userinfo response', async () => {
    const token = `userinfo-failure-${crypto.randomUUID()}`;
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return new Response(null, { status: 401 });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await rejectedHttpException(fetchUserInfo(token, 'https://issuer.example/userinfo'));
      expect(error.status).toBe(500);
      expect(error.message).toBe('Failed to fetch user info.');
    }
    expect(calls).toBe(2);
  });
});

describe('verifyAccessToken', () => {
  test('returns the payload of a correctly signed token for the configured issuer and audience', async () => {
    const issuer = 'https://issuer.example';
    const audience = 'gateway';
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'auth-test';
    const token = await new SignJWT({ scope: 'logs:read' })
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const provider = {
      issuer,
      userinfoUri: `${issuer}/userinfo`,
      jwkSet: createLocalJWKSet({ keys: [publicJwk] }) as never,
    };

    const payload = await verifyAccessToken(token, provider, audience);

    expect(payload.sub).toBe('user-1');
    expect(payload.scope).toBe('logs:read');
  });

  test('sanitizes JOSE verification failures into a 401 without exposing token claims', async () => {
    const issuer = 'https://issuer.example';
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const token = await new SignJWT({ secret_claim: 'must-not-leak' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(issuer)
      .setAudience('different-audience')
      .setExpirationTime('5m')
      .sign(privateKey);
    const provider = {
      issuer,
      userinfoUri: `${issuer}/userinfo`,
      jwkSet: createLocalJWKSet({ keys: [publicJwk] }) as never,
    };

    const error = await rejectedHttpException(verifyAccessToken(token, provider, 'gateway'));

    expect(error.status).toBe(401);
    expect(String(error.cause)).toContain('ERR_JWT_CLAIM_VALIDATION_FAILED');
    expect(String(error.cause)).not.toContain('must-not-leak');
  });

  test('does not disguise unexpected resolver failures as bad credentials', async () => {
    const issuer = 'https://issuer.example';
    const { privateKey } = await generateKeyPair('ES256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(issuer)
      .setAudience('gateway')
      .setExpirationTime('5m')
      .sign(privateKey);
    const resolverFailure = new Error('JWKS transport failed');
    const provider = {
      issuer,
      userinfoUri: `${issuer}/userinfo`,
      jwkSet: (async () => {
        throw resolverFailure;
      }) as never,
    };

    try {
      await verifyAccessToken(token, provider, 'gateway');
      throw new Error('Expected verification to fail');
    } catch (error) {
      expect(error).toBe(resolverFailure);
    }
  });
});
