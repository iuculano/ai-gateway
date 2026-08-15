import { error, redirect } from '@sveltejs/kit';
import { exchangeCode } from '$lib/server/oidc';
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

  let flow: { state: string; verifier: string };
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

  const claims = tokens.idTokenClaims;
  await createSession(cookies, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    user: {
      name: typeof claims.name === 'string' ? claims.name : undefined,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      username: typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
    },
  });

  redirect(302, '/');
};
