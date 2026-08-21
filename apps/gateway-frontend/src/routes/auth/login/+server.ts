import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { buildAuthorizationUrl } from '$lib/server/oidc';
import type { RequestHandler } from './$types';

/**
 * Where to send the user once they come back, if it is somewhere on this site.
 *
 * Anything else is discarded. A `redirect_to` echoed back without this check is
 * an open redirect: an attacker links to /auth/login?redirect_to=https://evil,
 * and the user is bounced there wearing a fresh session, from a URL on the real
 * domain. Protocol-relative values ('//evil') and backslash variants matter
 * because both are absolute URLs to a browser despite starting with a slash.
 */
function safeRedirect(value: string | null): string {
  if (!value?.startsWith('/')) {
    return '/';
  }
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}

export const GET: RequestHandler = async ({ url, cookies }) => {
  const { url: authorizationUrl, state, verifier } = await buildAuthorizationUrl(url.origin);

  // Short-lived cookie carrying the CSRF state, the PKCE verifier, and the
  // post-login destination across the round-trip to the IDP. The destination
  // rides here rather than in the OIDC `state` parameter so it is never
  // attacker-supplied on the way back.
  cookies.set(
    'oidc_flow',
    JSON.stringify({
      state,
      verifier,
      redirectTo: safeRedirect(url.searchParams.get('redirect_to')),
    }),
    {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: !dev,
      maxAge: 600,
    },
  );

  redirect(302, authorizationUrl);
};
