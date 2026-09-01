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
    // Awaited on purpose, even though revokeRefreshToken swallows its own
    // failures. Best-effort describes how it handles a FAILURE, not whether it
    // runs: firing it off unawaited would let the response return first and
    // leave the call racing process teardown, and a revocation that never
    // reaches the IDP leaves a long-lived credential valid.
    //
    // One round trip on an action a user takes rarely is worth that guarantee.
    // The local session is already gone either way - it was cleared above - so
    // this cannot leave anyone signed in.
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
