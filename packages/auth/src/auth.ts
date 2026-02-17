import { organizationIdpLinks, organizations } from "@repo/drizzle/schemas"
import { db, eq, and } from '@repo/drizzle';
import { createCacheKey } from '@repo/core';
import { HTTPException } from 'hono/http-exception';
import { LRUCache } from 'lru-cache';
import * as jose from 'jose';

interface Organization {
  id: string;
  name: string;
  status: string;
}

interface User {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  username: string;
  email: string;
  role?: string;
}

export interface ValidatedToken {
  organization: Organization;
  user: User;
}

// Try to cache in process for a while, this is going to be called all the time.
const organizationCache = new LRUCache<string, Organization>({
  max: 1000,
  ttl: 1000 * 60 * 15,
});

/**
 * Fetches an organization from the database based on the provided external id
 * and issuer. This is so we can expose only the idp-agnostic representation of
 * an organization and abstract away the details of the underlying identity
 * provider.
 *
 * Results are cached in-process & in-memory for 15 minutes. This is hot and
 * tries to avoid a network call.
 *
 * @returns
 * - 200 OK with the rendered prompt on success.
 */
async function getOrganizationByExternalIdpId(issuer: string, id: string) : Promise<Organization> {
  const cacheKey = createCacheKey('organizations:', `${issuer}:${id}`);
  const existing = organizationCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const result = await db.select()
    .from(organizationIdpLinks)
    .leftJoin(
      organizations,
      eq(organizationIdpLinks.organization_id, organizations.id),
    )
    .where(and(
      eq(organizationIdpLinks.external_organization_id, id),
    ))
    .limit(1);

  if (!result[0] || !result[0].organizations) {
    throw new HTTPException(500, {
      message: 'Organization not found.',
    });
  }

  if (result[0].organizations.status !== 'active') {
    throw new HTTPException(403, {
      message: 'Organization is not active.',
    });
  }

  const organization: Organization = {
    id: result[0].organizations.id,
    name: result[0].organizations.name,
    status: result[0].organizations.status,
  };

  organizationCache.set(cacheKey, organization);
  return organization;
}

interface OpenIDConfig {
  issuer: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

// What kind of cache strategy makes sense here? Is this dumb?
const openidUrlCache = new LRUCache<string, OpenIDConfig>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/**
 * Fetches and cachhes OpenID configuration endpoints from the given URL.
 *
 * Intended to reduce network calls.
 */
async function getCachedOpenIDConfig(openidUrl: string): Promise<OpenIDConfig> {
  const cacheKey = createCacheKey('openid-config:', openidUrl);
  const existing = openidUrlCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const data = await fetch(openidUrl);
  if (!data.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch OpenID configuration.',
    });
  }

  const openidConfig = await data.json() as {
    issuer: string,
    userinfo_endpoint: string,
    jwks_uri: string ,
  };

  if (!openidConfig.issuer || !openidConfig.jwks_uri || !openidConfig.userinfo_endpoint) {
    throw new HTTPException(500, {
      message: 'OpenID configuration missing required fields.',
    });
  }

  openidUrlCache.set(cacheKey, openidConfig);
  return openidConfig;
}


const userInfoCache = new LRUCache<string, User>({
  max: 10000,
  ttl: 1000 * 60 * 5,
});

/**
 * POST /prompts/:id/versions/:version
 * Render a prompt version with provided inputs, replacing the templating.
 *
 * @returns
 * - 200 OK with the rendered prompt on success.
 */
async function getCachedUserInfo(token: string, endpoint: string): Promise<User> {
  // Be mindful here of the cache key - it's hashed and the direct token is
  // never stored.
  const cacheKey = createCacheKey('openid-user-info:', token);
  const existing = await userInfoCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch user info.',
    });
  }

  const data = await response.json() as {
    name?: string;
    given_name?: string;
    family_name?: string;
    preferred_username?: string;
    email?: string;
    ['urn:zitadel:iam:org:project:roles']?: Record<string, string>;
  };

  // Roles come in with a bit of a fugly format from ZITADEL... need to parse
  // them out...
  //
  // "urn:zitadel:iam:org:project:roles":{ "role_name_here": {... },
  // }
  //
  // There can technically be multiple roles, but for now just assume one.
  const claim = data['urn:zitadel:iam:org:project:roles'];
  const role = claim ? Object.keys(claim)[0] : undefined;

  if (!data.preferred_username) {
    throw new HTTPException(500, {
      message: 'Malformed username',
    });
  }

  const userInfo: User = {
    displayName: data.name,
    firstName: data.given_name,
    lastName: data.family_name,
    username: data.preferred_username,
    email: data.email ?? data.preferred_username,
    role: role,
  };

  userInfoCache.set(cacheKey, userInfo);
  return userInfo;
}

let jwksCache: unknown = null;

export async function validateJwt(token: string): Promise<ValidatedToken> {
  const openidConfig = await getCachedOpenIDConfig(`${process.env.IDENTITY_PROVIDER_ISSUER}/.well-known/openid-configuration`);

  // If I'm understanding this right, this should handle caching and refetching
  // the JWKS as needed...
  // https://github.com/panva/jose/discussions/653
  if (!jwksCache) {
    jwksCache = jose.createRemoteJWKSet(new URL(openidConfig.jwks_uri));
  }

  const { payload } = await jose.jwtVerify(token, jwksCache as never, {
    issuer: process.env.IDENTITY_PROVIDER_ISSUER,
  });

  // TODO: adapt tokens, support multiple idps.
  const externalOrganizationId = payload['urn:zitadel:iam:user:resourceowner:id'] as string;
  if (!externalOrganizationId) {
    // Technically a valid token, but missing an expected claim that we need to
    // identify the user.
    throw new HTTPException(401, {
      message: 'Invalid token: missing required claims',
    });
  }

  const org = await getOrganizationByExternalIdpId(openidConfig.issuer, externalOrganizationId);
  const user = await getCachedUserInfo(token, openidConfig.userinfo_endpoint);

  return {
    organization: org,
    user: user,
  };
}
