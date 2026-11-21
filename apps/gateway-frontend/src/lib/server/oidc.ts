import * as client from 'openid-client';
import { dev } from '$app/env';
import { OIDC_REFRESH_ENABLED, POST_LOGOUT_REDIRECT_URI, ZITADEL_CLIENT_ID, ZITADEL_ISSUER } from '$app/env/private';

// This app runs the OIDC authorization code flow against the identity provider,
// with PKCE and no client secret, and keeps the tokens in a server-side
// session. The browser never sees one.
//
// The protocol itself is left to openid-client, which also checks what the
// provider sends back, such as who issued an ID token, who it is for and
// whether it has expired.

// The standard profile claims, and the Zitadel scopes that put the organization
// and the project roles on the token.
const SCOPES = [
  'openid',
  'profile',
  'email',
  'urn:zitadel:iam:user:resourceowner',
  'urn:zitadel:iam:org:project:roles',
];

// How long the provider is given to answer. Without a limit, a provider that
// hangs would hang every request that has to ask it something.
export const PROVIDER_TIMEOUT_MS = 4_000;

/**
 * Thrown when the provider refuses a grant for good, as it does a refresh token
 * that is spent, revoked or expired. Any other failure says nothing about the
 * grant, only that the provider could not be asked.
 */
export class GrantRefused extends Error {}

export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
}

export interface TokenResult {
  accessToken: string;
  expiresIn: number;

  /**
   * Present only when the provider issued one, which it does when refresh is
   * switched on here and granted to the application there.
   */
  refreshToken?: string;

  /**
   * The raw ID token, which names the session when signing out of the provider.
   */
  idToken?: string;

  /**
   * What the ID token says, once it has been checked.
   */
  claims?: Record<string, unknown>;
}

/**
 * The display-only fields the dashboard shows for the signed-in user.
 */
export interface UserProfile {
  name?: string;
  email?: string;
  username?: string;
}

let cachedConfiguration: client.Configuration | null = null;

/**
 * A setting that signing in cannot work without. It is checked on first use
 * and not at startup, so that the server can start without a provider.
 */
function required(name: 'ZITADEL_ISSUER' | 'ZITADEL_CLIENT_ID'): string {
  const value = name === 'ZITADEL_ISSUER' ? ZITADEL_ISSUER : ZITADEL_CLIENT_ID;

  if (!value) {
    throw new Error(`Missing ${name}. Set it in apps/gateway-frontend/.env.`);
  }

  return value;
}

/**
 * The provider's endpoints and this client's settings, discovered once and
 * kept.
 */
async function getConfiguration(): Promise<client.Configuration> {
  if (cachedConfiguration) {
    return cachedConfiguration;
  }

  const issuer = new URL(required('ZITADEL_ISSUER'));

  // A public client, which has no secret and sends only its id.
  cachedConfiguration = await client.discovery(issuer, required('ZITADEL_CLIENT_ID'), undefined, client.None(), {
    timeout: PROVIDER_TIMEOUT_MS / 1000,

    // The library speaks HTTPS only, and a provider on a developer's own
    // machine may not.
    execute: dev ? [client.allowInsecureRequests] : [],
  });

  return cachedConfiguration;
}

/**
 * Runs a token grant, and sorts a refusal of the grant from every other
 * failure.
 */
async function grant(
  request: Promise<client.TokenEndpointResponse & client.TokenEndpointResponseHelpers>,
): Promise<TokenResult> {
  let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;

  try {
    tokens = await request;
  } catch (error) {
    if (error instanceof client.ResponseBodyError && error.error === 'invalid_grant') {
      throw new GrantRefused(error.message, { cause: error });
    }

    throw error;
  }

  const expiresIn = tokens.expiresIn();

  // The session is built around when the access token expires, so a response
  // that does not say is no use to it.
  if (expiresIn === undefined) {
    throw new Error('The token response does not say when the access token expires.');
  }

  return {
    accessToken: tokens.access_token,
    expiresIn: expiresIn,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    claims: tokens.claims(),
  };
}

/**
 * The address to send the browser to for signing in, with the state and the
 * PKCE verifier that the callback has to match it against.
 */
export async function buildAuthorizationUrl(origin: string): Promise<AuthorizationRequest> {
  const configuration = await getConfiguration();
  const state = client.randomState();
  const verifier = client.randomPKCECodeVerifier();

  // A refresh token is only asked for when that is switched on. A provider
  // whose application has not been granted it may refuse the whole request,
  // which would break signing in for everyone. Everything after this goes by
  // whether a refresh token came back and not by the setting.
  const scopes = OIDC_REFRESH_ENABLED === 'true' ? [...SCOPES, 'offline_access'] : SCOPES;

  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: `${origin}/auth/callback`,
    scope: scopes.join(' '),
    state: state,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });

  return { url: url.href, state: state, verifier: verifier };
}

/**
 * Trades the code the provider sent back for tokens.
 *
 * @param callback
 * The address the provider sent the browser back to, code and state included.
 *
 * @param verifier
 * The PKCE verifier from when the sign-in began.
 *
 * @param state
 * The state from when the sign-in began, which the callback has to carry.
 */
export async function exchangeCode(callback: URL, verifier: string, state: string): Promise<TokenResult> {
  const configuration = await getConfiguration();

  return grant(
    client.authorizationCodeGrant(configuration, callback, { pkceCodeVerifier: verifier, expectedState: state }),
  );
}

/**
 * Trades a refresh token for new tokens. The provider rotates refresh tokens,
 * so the one passed in is dead once this returns and the caller must store the
 * result before doing anything else with it. It throws GrantRefused when the
 * token is no longer good.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenResult> {
  const configuration = await getConfiguration();

  return grant(client.refreshTokenGrant(configuration, refreshToken));
}

/**
 * Revokes a refresh token at the provider, and never throws.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  // A sign-out whose revocation fails must still clear the session here. The
  // alternative is a user who pressed Sign out and stayed signed in because
  // the provider was briefly unreachable.
  try {
    const configuration = await getConfiguration();

    if (configuration.serverMetadata().revocation_endpoint) {
      await client.tokenRevocation(configuration, refreshToken, { token_type_hint: 'refresh_token' });
    }
  } catch {}
}

/**
 * The address that ends the provider's own session, or null when the provider
 * has no such endpoint.
 */
export async function buildEndSessionUrl(idToken: string): Promise<string | null> {
  const configuration = await getConfiguration();

  if (!configuration.serverMetadata().end_session_endpoint) {
    return null;
  }

  const parameters: Record<string, string> = { id_token_hint: idToken };

  // Only sent when it is configured. The provider rejects an address it has
  // not been told about and strands the user on an error page, where leaving
  // it out lands them on the provider's own signed-out page.
  if (POST_LOGOUT_REDIRECT_URI) {
    parameters.post_logout_redirect_uri = POST_LOGOUT_REDIRECT_URI;
  }

  return client.buildEndSessionUrl(configuration, parameters).href;
}

/**
 * A claim as display text, or undefined when it is missing or empty.
 */
function claim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickProfile(claims: Record<string, unknown>): UserProfile {
  return {
    name: claim(claims.name),
    email: claim(claims.email),
    username: claim(claims.preferred_username),
  };
}

/**
 * The signed-in user's display claims, from the ID token when it carries them
 * and from UserInfo when it does not.
 */
export async function resolveUserProfile(tokens: TokenResult): Promise<UserProfile> {
  // Zitadel puts profile claims in the ID token only when the application is
  // set to, which the `profile` and `email` scopes alone do not do. Reading
  // both keeps the user named however the provider is configured.
  const fromIdToken = pickProfile(tokens.claims ?? {});
  const subject = claim(tokens.claims?.sub);

  if (fromIdToken.name || fromIdToken.email || fromIdToken.username || !subject) {
    return fromIdToken;
  }

  // A display name is not worth failing a sign-in over.
  try {
    const configuration = await getConfiguration();

    if (!configuration.serverMetadata().userinfo_endpoint) {
      return fromIdToken;
    }

    return pickProfile(await client.fetchUserInfo(configuration, tokens.accessToken, subject));
  } catch {
    return fromIdToken;
  }
}
