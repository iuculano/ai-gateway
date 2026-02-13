import { organizationIdpLinks, organizations } from "@db/schemas/organizations";
import { db, eq, and } from '@lib/drizzle';
import { createCacheKey } from '@lib/redis';
import { HTTPException } from 'hono/http-exception';
import { LRUCache } from 'lru-cache';
import * as jose from 'jose';
import type { Or } from "drizzle-orm";


interface Organization {
  id: string;
  name: string;
  status: string;
  issuer: string;
  openidUrl: string;
}

interface AuthenticatedRequest extends Organization {
  name: string;
  firstName: string;
  lastName: string;
  username: string; 
  email: string;
}


// Try to cache in process for a while, this is going to be called all the time.
const organizationCache = new LRUCache<string, Organization>({
  max: 1000,
  ttl: 1000 * 60 * 15,
});

async function getOrganizationByExternalIdpId(issuer: string, id: string) : Promise<Organization> {
  const cacheKey = await createCacheKey('organizations:', `${issuer}:${id}`);
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
      eq(organizationIdpLinks.issuer, issuer),
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
    issuer: result[0].organization_idp_links.issuer,
    openidUrl: result[0].organization_idp_links.openid_url,
  };

  organizationCache.set(cacheKey, organization);
  return organization;
}

// What kind of cache strategy makes sense here? Is this dumb?
const openidJwkUrlCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

async function getCachedJwksUrl(openidUrl: string): Promise<string> {
  const cacheKey = await createCacheKey('openid-jwks-url:', openidUrl);
  const existing = openidJwkUrlCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const data = await fetch(openidUrl);
  if (!data.ok) {
    throw new HTTPException(500, {
      message: 'Failed to fetch OpenID configuration.',
    });
  }

  const openidConfig = await data.json() as { jwks_uri: string };
  if (!openidConfig.jwks_uri) {
    throw new HTTPException(500, {
      message: 'OpenID configuration missing jwks_uri.',
    });
  }

  const url = openidConfig.jwks_uri;
  openidJwkUrlCache.set(cacheKey, url);

  return url;
}

async function validateJwt(token: string, organization: Organization): Promise<unknown> {
  const jwksUrl = await getCachedJwksUrl(organization.openidUrl);

  // If I'm understanding this right, this should handle caching and refetching
  // the JWKS as needed...
  // https://github.com/panva/jose/discussions/653
  const jwks = await jose.createRemoteJWKSet(new URL(jwksUrl));

  const { payload } = await jose.jwtVerify(token, jwks, {
    issuer: organization.issuer,
  });

  return payload;
}

