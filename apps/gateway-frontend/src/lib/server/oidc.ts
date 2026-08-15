import { createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

// The BFF side of auth: this app performs the OIDC authorization-code flow
// (with PKCE, no client secret) against the IDP and keeps the access token
// in an httpOnly cookie. The browser never sees a token; the /api proxy
// attaches it when talking to the backend.

interface OpenIDConfig {
  authorization_endpoint: string;
  token_endpoint: string;
}

// Scopes: standard profile claims, plus the Zitadel reserved scopes that put
// the resource owner (organization) claims and project roles on the token.
const SCOPES = [
  'openid',
  'profile',
  'email',
  'urn:zitadel:iam:user:resourceowner',
  'urn:zitadel:iam:org:project:roles',
].join(' ');

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
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, verifier };
}

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  idTokenClaims: Record<string, unknown>;
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

  const tokens = (await response.json()) as {
    access_token: string;
    expires_in: number;
    id_token?: string;
  };

  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    idTokenClaims: decodeJwtPayload(tokens.id_token),
  };
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
