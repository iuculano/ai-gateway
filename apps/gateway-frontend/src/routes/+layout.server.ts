import type { LayoutServerLoad } from './$types';

// The session is resolved and enforced in hooks.server.ts, which redirects
// unauthenticated page requests before this ever runs. The check below is a
// type narrowing rather than a second gate.
export const load: LayoutServerLoad = async ({ locals }) => {
  return { user: locals.session?.user };
};
