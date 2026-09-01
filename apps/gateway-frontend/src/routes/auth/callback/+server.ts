import { error, redirect } from '@sveltejs/kit';
import { exchangeCode, resolveUserProfile } from '$lib/server/oidc';
import { createSession } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const idpError = url.searchParams.get('error');
  if (idpError) {
    error(400, `Login failed: ${idpError} (${url.searchParams.get('error_description') ?? 'no details'})`);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const flowRaw = cookies.get('oidc_flow');
  if (!code || !state || !flowRaw) {
    error(400, 'Login failed: missing code, state, or flow cookie.');
  }

  let flow: { state: string; verifier: string; redirectTo?: string };
  try {
    flow = JSON.parse(flowRaw);
  } catch {
    error(400, 'Login failed: malformed flow cookie.');
  }

  if (state !== flow.state) {
    error(400, 'Login failed: state mismatch.');
  }

  const tokens = await exchangeCode(url.origin, code, flow.verifier);
  cookies.delete('oidc_flow', { path: '/auth' });

  // From the ID token when the IDP puts profile claims there, and from UserInfo
  // when it does not - see resolveUserProfile.
  const user = await resolveUserProfile(tokens);

  await createSession(cookies, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    // Absent unless OIDC_REFRESH_ENABLED is set AND the IDP application has the
    // refresh_token grant enabled. Everything downstream treats its absence as
    // "this session ends with its access token", which is what this app did
    // before refresh existed.
    refreshToken: tokens.refreshToken,
    // Kept solely so logout can present it as id_token_hint. Without it the
    // IDP has no idea which session to end.
    idToken: tokens.idToken,
    createdAt: Date.now(),
    user: user,
  });

  // The flow cookie is ours and was written by the login handler, which already
  // rejected anything not local to this site.
  redirect(302, flow.redirectTo ?? '/');
};
