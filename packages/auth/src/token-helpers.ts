import { createCacheKey } from '@repo/core';
import { HTTPException } from 'hono/http-exception';
import * as jose from 'jose';
import { LRUCache } from 'lru-cache';

// Token-facing building blocks adapters compose to turn a credential into a
// Caller: discovery, JWT verification, and userinfo. Identity resolution
// lives in ./users and ./organizations. Every helper here caches internally -
// adapters stay thin and never need to concern themselves with avoiding
// repeat lookups.

interface OpenIDConfig {
  issuer: string;
  userinfoUri: string;
  jwksUri: string;
}

// What kind of cache strategy makes sense here? Is this dumb?
const openidUrlCache = new LRUCache<string, OpenIDConfig>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/**
 * Fetches and caches OpenID configuration endpoints from the given URL.
 */
async function getCachedOpenIDConfig(url: string): Promise<OpenIDConfig> {
  const cacheKey = `openid-config:${url}`;
  const existing = openidUrlCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const data = await fetch(url);
  if (!data.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch OpenID configuration.',
    });
  }

  // The discovery document uses the spec's snake_case names (OIDC Discovery
  // 1.0 section 3); map them onto our internal shape.
  const raw = (await data.json()) as {
    issuer?: string;
    userinfo_endpoint?: string;
    jwks_uri?: string;
  };

  if (!raw.issuer || !raw.jwks_uri || !raw.userinfo_endpoint) {
    throw new HTTPException(500, {
      message: 'OpenID configuration missing required fields.',
    });
  }

  const openidConfig: OpenIDConfig = {
    issuer: raw.issuer,
    userinfoUri: raw.userinfo_endpoint,
    jwksUri: raw.jwks_uri,
  };

  openidUrlCache.set(cacheKey, openidConfig);
  return openidConfig;
}

type JWKSet = ReturnType<typeof jose.createRemoteJWKSet>;

// One resolver per JWKS endpoint.
//
// Each resolver closes over jose's own key cache and refetch cooldown, so they
// have to be held across requests rather than rebuilt per call - that part is
// what the linked discussion covers. But a resolver is also bound to the URL it
// was constructed with, so a single shared slot would pin the whole process to
// whichever issuer happened to be seen first: a second issuer's tokens would be
// checked against the first issuer's keys and fail with JWKSNoMatchingKey.
//
// Keyed by uri, not bounded: the number of issuers comes from configuration,
// not from traffic.
// https://github.com/panva/jose/discussions/653
const jwkSets = new Map<string, JWKSet>();

function getJWKSet(jwksUri: string): JWKSet {
  let keySet = jwkSets.get(jwksUri);
  if (!keySet) {
    keySet = jose.createRemoteJWKSet(new URL(jwksUri));
    jwkSets.set(jwksUri, keySet);
  }

  return keySet;
}

/**
 * Verifies a bearer token against the configured identity provider's JWKS
 * and returns the verified payload. Discovery and key sets are cached.
 *
 * The issuer on the returned payload (payload.iss) is verified and safe to
 * use as the external_idp for the resolve helpers.
 */
export async function verifyAccessToken(token: string, issuer: string, audience: string): Promise<jose.JWTPayload> {
  const openidConfig = await getCachedOpenIDConfig(`${issuer}/.well-known/openid-configuration`);

  try {
    const { payload } = await jose.jwtVerify(token, getJWKSet(openidConfig.jwksUri), {
      issuer: issuer,
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
export async function fetchUserInfo(token: string, issuer: string): Promise<Record<string, unknown>> {
  // Be mindful here of the cache key - it's hashed and the direct token is
  // never stored.
  const cacheKey = createCacheKey('openid-user-info:', token);
  const existing = userInfoCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const openidConfig = await getCachedOpenIDConfig(`${issuer}/.well-known/openid-configuration`);

  const response = await fetch(openidConfig.userinfoUri, {
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
