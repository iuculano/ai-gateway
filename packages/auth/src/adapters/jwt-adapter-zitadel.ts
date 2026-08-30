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

type ZitadelAccessToken = JWTPayload & {
  [CLAIMS.organizationId]?: string;
  [CLAIMS.organizationName]?: string;
  [CLAIMS.roles]?: unknown;
};

type ZitadelUserInfo = Record<string, unknown> & {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  [CLAIMS.roles]?: unknown;
};

function tokenIdentity(payload: ZitadelAccessToken) {
  const externalOrganizationId = payload[CLAIMS.organizationId];
  const externalUserId = payload.sub;

  if (!externalOrganizationId || !externalUserId) {
    throw new HTTPException(401, {
      cause: 'Invalid token: missing required claims',
    });
  }

  return {
    externalOrganizationId,
    externalUserId,
    organizationName: payload[CLAIMS.organizationName],
  };
}

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
  if (!username) {
    throw new HTTPException(500, {
      cause: 'Userinfo response: missing required claims',
    });
  }

  const email = userInfo.email ?? username;
  const displayName = userInfo.name;

  const userId = await resolveUser(issuer, externalUserId, {
    username: username,
    email: email,
    name: displayName ?? username,
  });

  return {
    user: {
      id: userId,
      username: username,
      email: email,
      displayName: displayName,
      firstName: userInfo.given_name,
      lastName: userInfo.family_name,
    },
    roles: userInfo[CLAIMS.roles],
  };
}

/**
 * Resolves the caller's effective scopes from an access token.
 *
 * @param payload
 * The verified access token payload.
 *
 * @param userInfoRoles
 * Roles from userinfo, used when the token has none.
 *
 * @param roleScopesMap
 * Mapping of roles to scopes. If empty, the token's scopes will be used
 * instead.
 *
 * @returns
 * Array of effective scopes for the caller.
 */
function resolveScopes(
  payload: ZitadelAccessToken,
  userInfoRoles: unknown,
  roleScopesMap: Record<string, string[]>,
): string[] {
  // If there's no role mapping, try to grab the scopes from the token itself.
  if (Object.keys(roleScopesMap).length === 0) {
    return normalizeScopes(payload.scope);
  }

  // Try to grab them from the access token first, then fall back to the
  // userinfo response. Zitadel needs an option set to put them on the token.
  const tokenRoles = normalizeRoles(payload[CLAIMS.roles]);
  const roles = tokenRoles.length > 0 ? tokenRoles : normalizeRoles(userInfoRoles);

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
    const payload = (await verifyAccessToken(token, provider, options.audience)) as ZitadelAccessToken;

    const { externalOrganizationId, externalUserId, organizationName } = tokenIdentity(payload);
    const { user, roles } = await resolveTokenUser(token, options.issuer, provider.userinfoUri, externalUserId);
    const organization = await resolveOrganization(options.issuer, externalOrganizationId, organizationName);
    const scopes = resolveScopes(payload, roles, options.roleScopesMap);

    return {
      organization: {
        id: organization.id,
        name: organization.name,
      },

      actor: {
        type: 'user',
        user: user,
      },

      permissions: {
        scopes: scopes,
      },
    };
  };
}
