import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The cookie the login route leaves behind for the callback to check the round
 * trip against.
 */
function flowCookie(state: string): string {
  const flow = JSON.stringify({ state: state, verifier: 'verifier', redirectTo: '/' });

  return `oidc_flow=${encodeURIComponent(flow)}`;
}

// Protected routes

test('a visitor without a session is sent to sign in and back to where they were going', async ({ request }) => {
  const response = await request.get('/keys?status=active', { maxRedirects: 0 });

  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe('/auth/login?redirect_to=%2Fkeys%3Fstatus%3Dactive');
});

test('an API request without a session is refused rather than redirected', async ({ request }) => {
  // A redirect would hand the page's fetch a login document where it expects
  // JSON.
  const response = await request.get('/api/models/providers', { maxRedirects: 0 });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: { code: 401, message: 'Not authenticated.' } });
});

// Sign-in callback

test('a sign-in the identity provider refused is reported', async ({ request }) => {
  const response = await request.get('/auth/callback?error=access_denied&error_description=User+cancelled');

  expect(response.status()).toBe(400);
  expect(await response.text()).toContain('Login failed: access_denied (User cancelled)');
});

test('a callback whose state does not match the one this browser started with is refused', async ({ request }) => {
  // The state is what ties a callback to the login this browser began, so a
  // mismatch means the code was issued for somebody else's attempt.
  const response = await request.get('/auth/callback?code=stolen-code&state=attacker', {
    headers: { cookie: flowCookie('expected') },
  });

  expect(response.status()).toBe(400);
  expect(await response.text()).toContain('state mismatch');
});

test('a callback without the flow cookie is refused', async ({ request }) => {
  const response = await request.get('/auth/callback?code=some-code&state=some-state');

  expect(response.status()).toBe(400);
  expect(await response.text()).toContain('missing code, state, or flow cookie');
});
