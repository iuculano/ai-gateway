import { redirect } from '@sveltejs/kit';
import { buildAuthorizationUrl } from '#lib/server/oidc.ts';
import { dev } from '$app/env';
import type { RequestEvent } from './$types';

/**
 * Where to send the visitor once they are signed in.
 */
function returnPath(value: string | null, origin: string): string {
  const target = URL.parse(value ?? '/', origin);

  if (target?.origin !== origin) {
    return '/';
  }

  return target.pathname + target.search + target.hash;
}

/**
 * Starts a sign-in by sending the browser to the identity provider.
 */
export async function GET({ url, cookies }: RequestEvent): Promise<never> {
  const authorization = await buildAuthorizationUrl(url.origin);

  // What the callback needs to finish the round trip. The way back rides here
  // and not in the `state` parameter, so that nobody else can supply it on the
  // return.
  const flow = {
    state: authorization.state,
    verifier: authorization.verifier,
    redirectTo: returnPath(url.searchParams.get('redirect_to'), url.origin),
  };

  cookies.set('oidc_flow', JSON.stringify(flow), {
    path: '/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: 600,
  });

  // The identity provider is another origin, which SvelteKit refuses unless
  // told. Its address comes from its own discovery document and never from the
  // request.
  redirect(302, authorization.url, { external: true });
}
