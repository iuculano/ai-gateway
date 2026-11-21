import { error, redirect } from '@sveltejs/kit';
import { exchangeCode, resolveUserProfile } from '#lib/server/oidc.ts';
import { createSession } from '#lib/server/session.ts';
import type { RequestEvent } from './$types';

/**
 * Finishes a sign-in by trading the identity provider's code for a session.
 */
export async function GET({ url, cookies }: RequestEvent): Promise<never> {
  const refusal = url.searchParams.get('error');

  if (refusal) {
    error(400, `Login failed: ${refusal} (${url.searchParams.get('error_description') ?? 'no details'})`);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const stored = cookies.get('oidc_flow');

  if (!code || !state || !stored) {
    error(400, 'Login failed: missing code, state, or flow cookie.');
  }

  let flow: { state: string; verifier: string; redirectTo: string };

  try {
    flow = JSON.parse(stored);
  } catch {
    error(400, 'Login failed: malformed flow cookie.');
  }

  // The state is what ties this callback to the sign-in this browser began.
  if (state !== flow.state) {
    error(400, 'Login failed: state mismatch.');
  }

  const tokens = await exchangeCode(url, flow.verifier, flow.state);
  cookies.delete('oidc_flow', { path: '/auth' });

  await createSession(cookies, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    createdAt: Date.now(),
    user: await resolveUserProfile(tokens),
  });

  // The login handler wrote this, and kept only a path on this site.
  redirect(302, flow.redirectTo);
}
