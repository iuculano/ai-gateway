import { type Handle, json, redirect } from '@sveltejs/kit';
import { getValidSession } from '$lib/server/session';

/**
 * Routes reachable without a session.
 *
 * Everything else is protected by default. The previous arrangement enforced
 * auth in +layout.server.ts for pages and in the proxy for /api, which covered
 * everything that existed but meant a new +server.ts route outside /api would
 * be public until somebody remembered to guard it. Failing closed here makes
 * forgetting impossible.
 */
const PUBLIC_PREFIXES = ['/auth/'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const handle: Handle = async ({ event, resolve }) => {
  // Resolved once per request, so a page load and the API calls it triggers
  // cannot each decide independently to renew the same session.
  event.locals.session = await getValidSession(event.cookies);

  // route.id is null for anything that matched no route - static assets, the
  // immutable /_app bundles, plain 404s. Guarding those would block the
  // client bundle and break the app for exactly the users who need to log in.
  const isRoute = event.route.id !== null;

  if (isRoute && !isPublic(event.url.pathname) && !event.locals.session) {
    if (event.url.pathname.startsWith('/api/')) {
      return json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
    }

    // Where they were headed, so the callback can put them back there rather
    // than on the overview page.
    const target = event.url.pathname + event.url.search;
    redirect(302, `/auth/login?redirect_to=${encodeURIComponent(target)}`);
  }

  return resolve(event);
};
