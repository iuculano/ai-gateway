import { expect, mock, test } from 'bun:test';
import { isRedirect } from '@sveltejs/kit';

const AUTHORIZATION_URL = 'https://idp.test/oauth/v2/authorize?client_id=test-client';

// Anything that is not a path on this site. The last three are absolute URLs to
// a browser even though two of them start with a slash.
const OFF_SITE_RETURN_PATHS = ['keys', 'https://evil.example/keys', '//evil.example/keys', '/\\evil.example/keys'];

// Must precede the import below, because the route reads both modules as it
// loads.
mock.module('$app/env', () => ({ dev: true }));
mock.module(new URL('../../src/lib/server/oidc.ts', import.meta.url).pathname, () => ({
  buildAuthorizationUrl: async () => ({ url: AUTHORIZATION_URL, state: 'state', verifier: 'verifier' }),
}));

const { GET } = await import('../../src/routes/auth/login/+server');

/**
 * Starts a login asked to come back to `redirectTo`, and reports where it sent
 * the browser and what it will return to.
 */
async function login(redirectTo: string): Promise<{ location: string; returnTo: string }> {
  const url = new URL('http://frontend.test/auth/login');
  url.searchParams.set('redirect_to', redirectTo);

  let flowCookie = '';
  const cookies = {
    set(_name: string, value: string): void {
      flowCookie = value;
    },
  };

  // The route answers by throwing its redirect, as every SvelteKit handler
  // does.
  let thrown: unknown;

  try {
    await GET({ url: url, cookies: cookies } as unknown as Parameters<typeof GET>[0]);
  } catch (error) {
    thrown = error;
  }

  if (!isRedirect(thrown)) {
    throw new Error('Expected the login route to redirect');
  }

  return { location: thrown.location, returnTo: JSON.parse(flowCookie).redirectTo };
}

test('login sends the browser to the identity provider', async () => {
  const { location } = await login('/keys');

  expect(location).toBe(AUTHORIZATION_URL);
});

test('a return path on this site is kept for after sign-in', async () => {
  const { returnTo } = await login('/keys?status=active');

  expect(returnTo).toBe('/keys?status=active');
});

for (const redirectTo of OFF_SITE_RETURN_PATHS) {
  test(`a return path of ${redirectTo} is replaced with the home page`, async () => {
    // Echoing it back would bounce a freshly signed-in user to another site
    // from a link on this one.
    const { returnTo } = await login(redirectTo);

    expect(returnTo).toBe('/');
  });
}
