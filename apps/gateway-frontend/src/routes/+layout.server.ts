import type { UserProfile } from '#lib/server/oidc.ts';
import type { LayoutServerLoadEvent } from './$types';

export function load({ locals }: LayoutServerLoadEvent): { user: UserProfile | undefined } {
  // The hook has already turned away a page request with no session, so the
  // user is only missing on a page that matched no route.
  return { user: locals.session?.user };
}
