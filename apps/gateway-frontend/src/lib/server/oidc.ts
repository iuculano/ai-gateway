import { createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

// The BFF side of auth: this app performs the OIDC authorization-code flow
// (with PKCE, no client secret) against the IDP and keeps the tokens in a
// server-side session. The browser never sees a token; the /api proxy attaches
// the access token when talking to the backend.

interface OpenIDConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  /** Optional: RP-initiated logout. Absent on IDPs that do not support it. */
  end_session_endpoint?: string;
  /** Optional: RFC 7009 token revocation. */
  revocation_endpoint?: string;
  /** Optional: OIDC UserInfo, the fallback source of display claims. */
  userinfo_endpoint?: string;
}

// Standard profile claims, plus the Zitadel reserved scopes that put the
// resource owner (organization) claims and project roles on the token.
const BASE_SCOPES = [
  'openid',
  'profile',
  'email',
  'urn:zitadel:iam:user:resourceowner',
  'urn:zitadel:iam:org:project:roles',
];

/**
 * Whether to ask the IDP for a refresh token.
 *
 * Off by default, and deliberately so. `offline_access` is only honoured once
 * the refresh_token grant is enabled on the IDP application itself, and an IDP
 * that has not been configured for it may reject the authorization request
 * outright rather than quietly omitting the token - which would break login for
 * everyone. Enabling the grant in the IDP console and setting this flag are one
 * change made in two places, in that order.
 *
 * Everything downstream keys off whether a refresh token actually arrived, not
 * off this flag, so a mismatch degrades to the previous behaviour rather than
 * failing.
 */
function refreshRequested(): boolean {
  return env.OIDC_REFRESH_ENABLED === 'true';
}

function scopeParameter(): string {
  return (refreshRequested() ? [...BASE_SCOPES, 'offline_access'] : BASE_SCOPES).join(' ');
}

let cachedConfig: OpenIDConfig | null = null;

function requiredEnv(name: 'ZITADEL_ISSUER' | 'ZITADEL_CLIENT_ID'): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name} - set it in apps/frontend/.env.`);
  }
  return value;
}

async function getOpenIDConfig(): Promise<OpenIDConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const issuer = requiredEnv('ZITADEL_ISSUER');
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenID configuration from ${issuer}.`);
  }

  const config = (await response.json()) as OpenIDConfig;
  if (!config.authorization_endpoint || !config.token_endpoint) {
    throw new Error('OpenID configuration missing required endpoints.');
  }

  cachedConfig = config;
  return config;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
}

export async function buildAuthorizationUrl(origin: string): Promise<AuthorizationRequest> {
  const config = await getOpenIDConfig();
  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const url = new URL(config.authorization_endpoint);
  url.searchParams.set('client_id', requiredEnv('ZITADEL_CLIENT_ID'));
  url.searchParams.set('redirect_uri', `${origin}/auth/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopeParameter());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, verifier };
}

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  /** Present only when the IDP issued one - see refreshRequested(). */
  refreshToken?: string;
  /** The raw ID token, kept for `id_token_hint` on RP-initiated logout. */
  idToken?: string;
  idTokenClaims: Record<string, unknown>;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

function toTokenResult(tokens: TokenResponse): TokenResult {
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    idTokenClaims: decodeJwtPayload(tokens.id_token),
  };
}

export async function exchangeCode(origin: string, code: string, verifier: string): Promise<TokenResult> {
  const config = await getOpenIDConfig();

  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: requiredEnv('ZITADEL_CLIENT_ID'),
      redirect_uri: `${origin}/auth/callback`,
      code: code,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }

  return toTokenResult((await response.json()) as TokenResponse);
}

/**
 * Trades a refresh token for a new access token.
 *
 * Zitadel rotates refresh tokens, so the response carries a NEW refresh token
 * and the one passed in is dead the moment this returns. Losing the response -
 * a crash, an unwritten session - therefore ends the session; the caller must
 * persist the result before doing anything else with it.
 *
 * Throws on any non-2xx. `invalid_grant` means the token was already rotated,
 * revoked, or expired, and there is no recovery except a fresh login.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenResult> {
  const config = await getOpenIDConfig();

  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: requiredEnv('ZITADEL_CLIENT_ID'),
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Refresh failed (${response.status}): ${await response.text()}`);
  }

  return toTokenResult((await response.json()) as TokenResponse);
}

/**
 * Revokes a refresh token at the IDP (RFC 7009).
 *
 * Best effort. A logout whose revocation call fails must still clear local
 * state, so this never throws - the alternative is a user who pressed Sign out
 * and stayed signed in because the IDP was briefly unreachable.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const config = await getOpenIDConfig();
    if (!config.revocation_endpoint) {
      return;
    }

    await fetch(config.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: requiredEnv('ZITADEL_CLIENT_ID'),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    });
  } catch {
    // Swallowed on purpose - see the doc comment.
  }
}

/**
 * The IDP URL that ends the IDP's OWN session, or null if it cannot be built.
 *
 * Without this, signing out clears the local session and immediately bounces
 * through /auth/login, where the IDP - whose session is untouched - issues a
 * fresh code and signs the user straight back in.
 *
 * `post_logout_redirect_uri` is only sent when POST_LOGOUT_REDIRECT_URI is
 * configured, because an unregistered value is rejected by the IDP and strands
 * the user on an error page. Without it the user lands on the IDP's own
 * signed-out page, which is worse UX but still correct.
 */
export async function buildEndSessionUrl(idToken: string): Promise<string | null> {
  const config = await getOpenIDConfig();
  if (!config.end_session_endpoint) {
    return null;
  }

  const url = new URL(config.end_session_endpoint);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('client_id', requiredEnv('ZITADEL_CLIENT_ID'));

  const postLogout = env.POST_LOGOUT_REDIRECT_URI;
  if (postLogout) {
    url.searchParams.set('post_logout_redirect_uri', postLogout);
  }

  return url.toString();
}

/** The display-only fields the dashboard shows for the signed-in user. */
export interface UserProfile {
  name?: string;
  email?: string;
  username?: string;
}

function pickProfile(claims: Record<string, unknown>): UserProfile {
  const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);

  return {
    name: str(claims.name),
    email: str(claims.email),
    username: str(claims.preferred_username),
  };
}

/**
 * The signed-in user's display claims, from the ID token or from UserInfo.
 *
 * Zitadel only puts profile claims in the ID token when "User Info inside ID
 * Token" is enabled on the application, and the `profile` and `email` scopes
 * alone do not make it happen. With that setting off the ID token carries only
 * `sub`, `sid` and the org claims, and the dashboard renders a nameless user.
 *
 * So the ID token is preferred - it is already in hand and costs nothing - and
 * UserInfo is the fallback. That way the app is correct whichever way the IDP
 * is configured, rather than depending on a console toggle nobody will remember
 * when they next set up an environment.
 */
export async function resolveUserProfile(tokens: TokenResult): Promise<UserProfile> {
  const fromIdToken = pickProfile(tokens.idTokenClaims);
  if (fromIdToken.name || fromIdToken.email || fromIdToken.username) {
    return fromIdToken;
  }

  const config = await getOpenIDConfig();
  if (!config.userinfo_endpoint) {
    return fromIdToken;
  }

  try {
    const response = await fetch(config.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    if (!response.ok) {
      return fromIdToken;
    }

    return pickProfile((await response.json()) as Record<string, unknown>);
  } catch {
    // A display name is not worth failing a login over.
    return fromIdToken;
  }
}

/**
 * Decodes a JWT payload WITHOUT verifying the signature. Only used for
 * display fields (name/email) straight off the token endpoint's TLS
 * response; the backend independently verifies the access token against the
 * JWKS on every request.
 */
function decodeJwtPayload(token?: string): Record<string, unknown> {
  const payload = token?.split('.')[1];
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}
