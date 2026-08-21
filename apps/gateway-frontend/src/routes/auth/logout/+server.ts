import { redirect } from '@sveltejs/kit';
import { buildEndSessionUrl, revokeRefreshToken } from '$lib/server/oidc';
import { destroySession } from '$lib/server/session';
import type { RequestHandler } from './$types';

/**
 * Signs the user out of this app AND of the IDP.
 *
 * Clearing local state alone is not a logout. /auth/login builds an
 * authorization request with no `prompt`, so an IDP whose own session is still
 * alive issues a code immediately and signs the user straight back in - they
 * see a flicker and remain logged in. Ending the IDP session is what makes the
 * button mean what it says.
 */
export const GET: RequestHandler = async ({ cookies }) => {
  // Read and clear in one step: whatever happens with the IDP below, this
  // browser is logged out locally before the response leaves. A logout that
  // half-fails must fail towards signed-out.
  const session = await destroySession(cookies);

  if (session?.refreshToken) {
    // Best effort, and deliberately not awaited into a failure path: an
    // unreachable IDP must not leave the user signed in. The refresh token
    // outlives the access token, so leaving it valid is the part that actually
    // matters here.
    await revokeRefreshToken(session.refreshToken);
  }

  if (session?.idToken) {
    const endSession = await buildEndSessionUrl(session.idToken);
    if (endSession) {
      redirect(302, endSession);
    }
  }

  // No ID token to present, or an IDP without RP-initiated logout: local state
  // is gone, which is the most this can do.
  redirect(302, '/auth/login');
};
