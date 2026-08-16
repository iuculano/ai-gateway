import { createCacheKey } from '@repo/core';
import { HTTPException } from 'hono/http-exception';
import * as jose from 'jose';
import { LRUCache } from 'lru-cache';

// Token-facing building blocks adapters compose to turn a credential into a
// Caller: provider initialization, JWT verification, and userinfo. Identity
// resolution lives in ./users and ./organizations.

type JWKSet = ReturnType<typeof jose.createRemoteJWKSet>;

interface OpenIDProvider {
  issuer: string;
  userinfoUri: string;
  jwkSet: JWKSet;
}

/**
 * Loads the OpenID configuration and JWKS resolver for an issuer.
 */
export async function loadOpenIDProvider(issuer: string): Promise<OpenIDProvider> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch OpenID configuration.',
    });
  }

  // The discovery document uses the spec's snake_case names (OIDC Discovery
  // 1.0 section 3); map them onto our internal shape.
  const raw = (await response.json()) as {
    issuer?: string;
    userinfo_endpoint?: string;
    jwks_uri?: string;
  };

  if (!raw.issuer || !raw.jwks_uri || !raw.userinfo_endpoint) {
    throw new HTTPException(500, {
      message: 'OpenID configuration missing required fields.',
    });
  }

  if (raw.issuer !== issuer) {
    throw new HTTPException(500, {
      message: 'OpenID configuration issuer does not match.',
    });
  }

  return {
    issuer: raw.issuer,
    userinfoUri: raw.userinfo_endpoint,
    jwkSet: jose.createRemoteJWKSet(new URL(raw.jwks_uri)),
  };
}

/**
 * Verifies a bearer token against the configured identity provider's JWKS
 * and returns the verified payload.
 *
 * The issuer on the returned payload (payload.iss) is verified and safe to
 * use as the external_idp for the resolve helpers.
 */
export async function verifyAccessToken(
  token: string,
  provider: OpenIDProvider,
  audience: string,
): Promise<jose.JWTPayload> {
  try {
    const { payload } = await jose.jwtVerify(token, provider.jwkSet, {
      issuer: provider.issuer,
      audience: audience,
    });

    return payload;
  } catch (error) {
    // A failed verification is the caller's 401, not our 500 - and jose
    // errors carry the raw claims payload, which must not hit the error log.
    if (error instanceof jose.errors.JOSEError) {
      throw new HTTPException(401, {
        cause: `Invalid token: ${error.code}`,
      });
    }

    throw error;
  }
}

const userInfoCache = new LRUCache<string, Record<string, unknown>>({
  max: 10000,
  ttl: 1000 * 60 * 5,
});

/**
 * Fetches and caches the raw userinfo response for a token. Interpreting the
 * response's claim shapes is the adapter's job.
 */
export async function fetchUserInfo(token: string, userinfoUri: string): Promise<Record<string, unknown>> {
  // Be mindful here of the cache key - it's hashed and the direct token is
  // never stored.
  const cacheKey = createCacheKey('openid-user-info:', token);
  const existing = userInfoCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const response = await fetch(userinfoUri, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch user info.',
    });
  }

  const data = (await response.json()) as Record<string, unknown>;

  userInfoCache.set(cacheKey, data);
  return data;
}
