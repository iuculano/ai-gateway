import { redirect } from '@sveltejs/kit';
import { readSession } from '$lib/server/session';
import type { LayoutServerLoad } from './$types';

// Every page requires a session; /auth/* are +server endpoints, so this
// load never runs for them and can't loop.
export const load: LayoutServerLoad = async ({ cookies }) => {
  const session = await readSession(cookies);
  if (!session) {
    redirect(302, '/auth/login');
  }

  return { user: session.user };
};
