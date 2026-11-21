import { redirect } from '@sveltejs/kit';
import { buildEndSessionUrl, revokeRefreshToken } from '#lib/server/oidc.ts';
import { destroySession } from '#lib/server/session.ts';
import type { RequestEvent } from './$types';

/**
 * Signs the visitor out of this app and of the identity provider.
 *
 * A POST and not a GET, so that a link on another site cannot sign anyone out.
 * SvelteKit turns away a form posted from another origin, and the session
 * cookie is not sent with one either.
 */
export async function POST({ cookies }: RequestEvent): Promise<never> {
  // Cleared first, so that whatever the identity provider does below, this
  // browser is already signed out here.
  const session = await destroySession(cookies);

  // Awaited even though it swallows its own failures. Left to finish after the
  // response, it could lose a race with the process stopping and leave a
  // long-lived credential valid.
  if (session?.refreshToken) {
    await revokeRefreshToken(session.refreshToken);
  }

  // Ending the provider's own session is what makes this a sign-out. Left
  // alive, it would answer the login page with a fresh code at once and sign
  // the visitor straight back in.
  const endSession = session?.idToken ? await buildEndSessionUrl(session.idToken) : null;

  // A 303, which is the redirect that turns the browser's POST back into a GET.
  if (endSession) {
    redirect(303, endSession, { external: true });
  }

  redirect(303, '/auth/login');
}
