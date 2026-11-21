import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Cookies, isHttpError, isRedirect } from '@sveltejs/kit';
import { getValidSession } from '../../src/lib/server/session';
import { GET as callback } from '../../src/routes/auth/callback/+server';
import { GET as login } from '../../src/routes/auth/login/+server';
import { POST as logout } from '../../src/routes/auth/logout/+server';
import { clearSessions, ENDPOINTS, FakeIdp, fakeCookies } from './fakes';

// The three auth routes as one journey, with the real OIDC and session modules
// behind them and only the identity provider faked.

const ORIGIN = 'http://frontend.test';

let idp: FakeIdp;

/**
 * Asks a route for a path, and returns whatever it threw. SvelteKit's routes
 * answer with a redirect or an error by throwing it.
 */
async function thrownBy(route: (event: never) => Promise<never>, path: string, cookies: Cookies): Promise<unknown> {
  const event = { url: new URL(path, ORIGIN), cookies: cookies };

  try {
    await route(event as never);
  } catch (thrown) {
    return thrown;
  }
}

/**
 * Asks a route for a path, and returns where it sends the browser.
 */
async function redirectOf(route: (event: never) => Promise<never>, path: string, cookies: Cookies): Promise<string> {
  const thrown = await thrownBy(route, path, cookies);

  if (!isRedirect(thrown)) {
    throw new Error(`Expected ${path} to redirect`);
  }

  return thrown.location;
}

/**
 * Starts a sign-in, and returns the address the provider would send the
 * browser back to.
 */
async function callbackPath(cookies: Cookies, returnTo = '/'): Promise<string> {
  const start = `/auth/login?redirect_to=${encodeURIComponent(returnTo)}`;
  const authorize = new URL(await redirectOf(login, start, cookies));

  return `/auth/callback?code=the-code&state=${authorize.searchParams.get('state')}`;
}

/**
 * Signs in through the login and callback routes, and returns where the
 * visitor ends up.
 */
async function signIn(cookies: Cookies, returnTo = '/'): Promise<string> {
  return redirectOf(callback, await callbackPath(cookies, returnTo), cookies);
}

beforeEach(() => {
  idp = new FakeIdp();
});

afterEach(() => {
  idp.stop();
});

afterAll(clearSessions);

// Signing in

test('the code is traded with proof that the sign-in began in this browser', async () => {
  const cookies = fakeCookies();
  const authorize = new URL(await redirectOf(login, '/auth/login', cookies));
  const state = authorize.searchParams.get('state');

  await redirectOf(callback, `/auth/callback?code=the-code&state=${state}`, cookies);

  // PKCE. The provider was shown a hash when the sign-in began, and honours the
  // code only for whoever holds what was hashed.
  const [request] = idp.tokenRequests;
  const proof = createHash('sha256')
    .update(request?.get('code_verifier') ?? '')
    .digest('base64url');

  expect(request?.get('code')).toBe('the-code');
  expect(request?.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
  expect(proof).toBe(authorize.searchParams.get('code_challenge') ?? '');
});

test('signing in stores a session and returns the visitor to where they were going', async () => {
  const cookies = fakeCookies();
  idp.idTokenClaims = { name: 'Ada Lovelace', email: 'ada@example.test', preferred_username: 'ada' };

  const landed = await signIn(cookies, '/keys?status=active');
  const session = await getValidSession(cookies);

  expect(landed).toBe('/keys?status=active');
  expect(session?.accessToken).toBe('access-1');
  expect(session?.user).toEqual({ name: 'Ada Lovelace', email: 'ada@example.test', username: 'ada' });
});

test('the user is named from UserInfo when the ID token does not say', async () => {
  const cookies = fakeCookies();
  idp.userInfo = { name: 'Grace Hopper' };

  await signIn(cookies);
  const session = await getValidSession(cookies);

  expect(session?.user.name).toBe('Grace Hopper');
});

test('a callback with the wrong state is refused before the code is traded', async () => {
  const cookies = fakeCookies();
  await redirectOf(login, '/auth/login', cookies);

  const thrown = await thrownBy(callback, '/auth/callback?code=stolen-code&state=attacker', cookies);

  expect(isHttpError(thrown, 400)).toBe(true);
  expect(idp.tokenRequests).toHaveLength(0);
});

test('an ID token issued for another application is not accepted', async () => {
  const cookies = fakeCookies();
  idp.idTokenClaims = { aud: 'another-application' };

  const landed = await thrownBy(callback, await callbackPath(cookies), cookies);

  // The provider was asked and answered, so what refused the sign-in was the
  // check on its answer.
  expect(idp.tokenRequests).toHaveLength(1);
  expect(isRedirect(landed)).toBe(false);
  expect(await getValidSession(cookies)).toBeNull();
});

test('a provider that does not say when the token expires cannot sign anyone in', async () => {
  const cookies = fakeCookies();
  idp.expiresIn = undefined;

  const landed = await thrownBy(callback, await callbackPath(cookies), cookies);

  // The provider was asked and answered, so what refused the sign-in was the
  // check on its answer.
  expect(idp.tokenRequests).toHaveLength(1);
  expect(isRedirect(landed)).toBe(false);
  expect(await getValidSession(cookies)).toBeNull();
});

// Signing out

test('signing out ends the session here and at the identity provider', async () => {
  const cookies = fakeCookies();
  await signIn(cookies);
  const session = await getValidSession(cookies);

  const location = new URL(await redirectOf(logout, '/auth/logout', cookies));

  expect(location.origin + location.pathname).toBe(ENDPOINTS.end_session_endpoint);
  expect(location.searchParams.get('id_token_hint')).toBe(session?.idToken ?? '');
  expect(idp.revoked).toEqual(['refresh-1']);
  expect(await getValidSession(cookies)).toBeNull();
});

test('signing out with no session goes back to signing in', async () => {
  const location = await redirectOf(logout, '/auth/logout', fakeCookies());

  expect(location).toBe('/auth/login');
});
