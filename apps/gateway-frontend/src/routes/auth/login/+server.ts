import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { buildAuthorizationUrl } from '$lib/server/oidc';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const { url: authorizationUrl, state, verifier } = await buildAuthorizationUrl(url.origin);

  // Short-lived cookie carrying the CSRF state and PKCE verifier across the
  // round-trip to the IDP.
  cookies.set('oidc_flow', JSON.stringify({ state, verifier }), {
    path: '/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: 600,
  });

  redirect(302, authorizationUrl);
};
