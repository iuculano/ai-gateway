import type { JWTAuthAdapter } from '@repo/hono/auth-adapter';
import { HTTPException } from 'hono/http-exception';
import type { JWTPayload } from 'jose';
import { normalizeRoles, normalizeScopes } from '../claim-mappings';
import { resolveOrganization } from '../organizations';
import { rolesToScopes } from '../role-scopes';
import { fetchUserInfo, loadOpenIDProvider, verifyAccessToken } from '../token-helpers';
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
  sub?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  [CLAIMS.roles]?: unknown;
};

/**
 * Options for the Zitadel adapter.
 */
export interface ZitadelAdapterOptions {
  /** Mapping of roles to scopes. If not set, token scopes will be used instead. */
  roleScopesMap: Record<string, string[]>;

  /** The issuer of the access tokens. */
  issuer: string;

  /** The audience of the access tokens. */
  audience: string;
}

/**
 * Fetches the userinfo response and resolves the caller to our local user
 * id (provisioned just-in-time on first sight).
 */
async function resolveTokenUser(token: string, issuer: string, userinfoUri: string, externalUserId: string) {
  // Token's valid, try to fetch additional user info from the userinfo
  // endpoint.
  const userInfo = (await fetchUserInfo(token, userinfoUri)) as ZitadelUserInfo;

  if (userInfo.sub !== externalUserId) {
    throw new HTTPException(401, {
      cause: 'Invalid token: userinfo subject does not match token subject',
    });
  }

  const username = userInfo.preferred_username;
  if (typeof username !== 'string' || username.length === 0) {
    // Valid userinfo, but we can't identify the caller without a username.
    throw new HTTPException(500, {
      cause: 'Userinfo response: missing required claims',
    });
  }

  const email = typeof userInfo.email === 'string' && userInfo.email.length > 0 ? userInfo.email : username;
  const displayName = typeof userInfo.name === 'string' && userInfo.name.length > 0 ? userInfo.name : undefined;

  const userId = await resolveUser(issuer, externalUserId, {
    username: username,
    email: email,
    name: displayName ?? username,
  });

  return { userId, userInfo, username, email, displayName };
}

/**
 * Resolves the caller's effective scopes from an access token.
 *
 * @param payload
 * The verified access token payload.
 *
 * @param userInfo
 * The userinfo response, used as a fallback for roles if the token has none.
 *
 * @param roleScopesMap
 * Mapping of roles to scopes. If empty, the token's scopes will be used
 * instead.
 *
 * @returns
 * Array of effective scopes for the caller.
 */
function resolveScopes(
  payload: JWTPayload,
  userInfo: ZitadelUserInfo,
  roleScopesMap: Record<string, string[]>,
): string[] {
  // If there's no role mapping, try to grab the scopes from the token itself.
  if (Object.keys(roleScopesMap).length === 0) {
    return normalizeScopes(payload.scope);
  }

  // Try to grab them from the access token first, then fall back to the
  // userinfo response. Zitadel needs an option set to put them on the token.
  const tokenRoles = normalizeRoles(payload[CLAIMS.roles]);
  const roles = tokenRoles.length > 0 ? tokenRoles : normalizeRoles(userInfo[CLAIMS.roles]);

  return rolesToScopes(roles, roleScopesMap);
}

/**
 * Authentication adapter for handing Zitadel issued access tokens.
 */
export async function createZitadelAdapter(options: ZitadelAdapterOptions): Promise<JWTAuthAdapter> {
  const provider = await loadOpenIDProvider(options.issuer);

  return async ({ token }) => {
    // Verification first. Nothing of the following should be trusted until the
    // token is verified.
    const payload = await verifyAccessToken(token, provider, options.audience);

    // Zitadel scopes tokens to a resource owner - that's our
    // tenant/organization.
    const externalOrganizationId = payload[CLAIMS.organizationId];
    const externalUserId = payload.sub;

    if (
      typeof externalOrganizationId !== 'string' ||
      externalOrganizationId.length === 0 ||
      typeof externalUserId !== 'string' ||
      externalUserId.length === 0
    ) {
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
      provider.userinfoUri,
      externalUserId,
    );

    const rawOrganizationName = payload[CLAIMS.organizationName];
    const organizationName =
      typeof rawOrganizationName === 'string' && rawOrganizationName.length > 0 ? rawOrganizationName : undefined;
    const organization = await resolveOrganization(options.issuer, externalOrganizationId, organizationName);

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
          firstName:
            typeof userInfo.given_name === 'string' && userInfo.given_name.length > 0 ? userInfo.given_name : undefined,
          lastName:
            typeof userInfo.family_name === 'string' && userInfo.family_name.length > 0
              ? userInfo.family_name
              : undefined,
        },
      },

      permissions: {
        scopes: scopes,
      },
    };
  };
}
