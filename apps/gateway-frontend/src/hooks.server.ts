import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { getValidSession } from '#lib/server/session.ts';

// The routes reachable without a session all sit under this. Every other route
// is protected here and not one by one, so that a new one cannot be left public
// by being forgotten.
const PUBLIC_PREFIX = '/auth/';

/**
 * Resolves the session for every request, and turns away one that needs a
 * session and has none.
 */
export async function handle({ event, resolve }: Parameters<Handle>[0]): Promise<Response> {
  // Resolved once per request, so that a page load and the API calls it sets
  // off cannot each decide to renew the same session.
  event.locals.session = await getValidSession(event.cookies);

  // A request that matched no route has a null id, and is left to be answered
  // as the 404 it is.
  const route = event.route.id;

  if (route === null || route.startsWith(PUBLIC_PREFIX) || event.locals.session) {
    return resolve(event);
  }

  // Refused and not redirected, because a redirect would hand the page's fetch
  // a login document where it expects JSON.
  if (route.startsWith('/api/')) {
    return Response.json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
  }

  // Where they were headed, so that signing in puts them back there.
  const target = event.url.pathname + event.url.search;

  redirect(302, `/auth/login?redirect_to=${encodeURIComponent(target)}`);
}
