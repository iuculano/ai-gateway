import type { JWTAuthAdapter } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import type { JWTPayload } from 'jose';

import { normalizeRoles, normalizeScopes } from '../claim-mappings';
import { resolveOrganization } from '../organizations';
import { rolesToScopes } from '../role-scopes';
import { fetchUserInfo, verifyAccessToken } from '../token-helpers';
import { resolveUser } from '../users';

// Where Zitadel puts the claims we care about.
const CLAIMS = {
  organizationId: 'urn:zitadel:iam:user:resourceowner:id',
  organizationName: 'urn:zitadel:iam:user:resourceowner:name',
  roles: 'urn:zitadel:iam:org:project:roles',
} as const;

// The userinfo fields we consume. Zitadel mirrors the role claim here too.
// A type (not an interface) so it overlaps with the Record<string, unknown>
// that fetchUserInfo() returns.
type ZitadelUserInfo = {
  sub: string;
  preferred_username: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  [CLAIMS.roles]?: unknown;
};

export interface ZitadelAdapterOptions {
  roleScopesMap: Record<string, string[]>;

  issuer: string;
  audience: string;
}

/**
 * Fetches the userinfo response and resolves the caller to our local user
 * id (provisioned just-in-time on first sight).
 */
async function resolveTokenUser(token: string, issuer: string, externalUserId: string) {
  // Token's valid, try to fetch additional user info from the userinfo endpoint.
  const userInfo = (await fetchUserInfo(token, issuer)) as ZitadelUserInfo;

  if (userInfo.sub !== externalUserId) {
    throw new HTTPException(401, {
      cause: 'Invalid token: userinfo subject does not match token subject',
    });
  }

  const username = userInfo.preferred_username;
  if (!username) {
    // Valid userinfo, but we can't identify the caller without a username.
    throw new HTTPException(500, {
      cause: 'Userinfo response: missing required claims',
    });
  }

  const email = userInfo.email ?? username;
  const displayName = userInfo.name || undefined;

  const userId = await resolveUser(issuer, externalUserId, {
    username: username,
    email: email,
    name: displayName ?? username,
  });

  return { userId, userInfo, username, email, displayName };
}

/**
 * Resolves the caller's effective scopes: whatever the token carries, plus
 * what the caller's roles grant.
 *
 * Roles are an input here, not an output - they are expanded into scopes and
 * never reach the Caller, so nothing downstream can authorize against them.
 *
 * Prefer roles asserted on the access token itself; fall back to the userinfo
 * response - Zitadel only puts roles on the token when the project has "Assert
 * Roles on Authentication" enabled.
 */
function resolveScopes(
  payload: JWTPayload,
  userInfo: ZitadelUserInfo,
  roleScopesMap: Record<string, string[]>,
): string[] {
  const tokenRoles = normalizeRoles(payload[CLAIMS.roles]);
  const roles = tokenRoles.length > 0 ? tokenRoles : normalizeRoles(userInfo[CLAIMS.roles]);

  const scopes = new Set([...normalizeScopes(payload.scope), ...rolesToScopes(roles, roleScopesMap)]);

  return [...scopes];
}

/**
 * Builds an adapter for Zitadel-issued access tokens: verifies the JWT
 * against the expected issuer and audience, resolves the organization and
 * user (both provisioned just-in-time on first sight), and applies the
 * injected role -> scope policy to produce a Caller.
 */
export function createZitadelAdapter(options: ZitadelAdapterOptions): JWTAuthAdapter {
  return async ({ token }) => {
    // Verification first. Nothing of the following should be trusted until the
    // token is verified.
    const payload = await verifyAccessToken(token, options.issuer, options.audience);

    // Zitadel scopes tokens to a resource owner - that's our
    // tenant/organization.
    const externalOrganizationId = payload[CLAIMS.organizationId] as string;
    const externalUserId = payload.sub;

    if (!externalOrganizationId || !externalUserId) {
      // Technically a valid token, but missing a claim we need to identify the
      // caller. Somehow? No idea how these would be missing in practice...
      throw new HTTPException(401, {
        cause: 'Invalid token: missing required claims',
      });
    }

    // The userinfo response is needed twice: identity fields here, and as the
    // roles fallback in resolvePermissions().
    const { userId, userInfo, username, email, displayName } = await resolveTokenUser(
      token,
      options.issuer,
      externalUserId,
    );

    const organization = await resolveOrganization(
      options.issuer,
      externalOrganizationId,
      payload[CLAIMS.organizationName] as string | undefined,
    );

    const scopes = resolveScopes(payload, userInfo, options.roleScopesMap);

    return {
      organization: {
        id: organization.id,
        name: organization.name,
      },

      actor: {
        type: 'user',
        user: {
          id: userId,
          username: username,
          email: email,
          displayName: displayName,
          firstName: userInfo.given_name || undefined,
          lastName: userInfo.family_name || undefined,
        },
      },

      permissions: {
        scopes: scopes,
      },
    };
  };
}
