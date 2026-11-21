import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { redis } from '@repo/redis';
import type { Cookies } from '@sveltejs/kit';
import { createSession, destroySession, getValidSession, refreshSession } from '../../src/lib/server/session';
import { clearSessions, type FakeCookies, FakeIdp, fakeCookies } from './fakes';

// The real session module against a real Valkey, with only the identity
// provider faked. What is worth testing here is coordination, such as one token
// call per expiry and a rotated token stored before it is used, and none of
// that survives being rebuilt in a double.

let idp: FakeIdp;
let logged: Mock<typeof console.error>;

/**
 * Stores a session whose access token expires at a chosen offset from now.
 */
async function seed(
  cookies: Cookies,
  expiresInMs: number,
  options: { refreshToken?: string; ageMs?: number } = {},
): Promise<void> {
  await createSession(cookies, {
    accessToken: 'access-0',
    expiresAt: Date.now() + expiresInMs,
    refreshToken: 'refreshToken' in options ? options.refreshToken : 'refresh-0',
    idToken: 'id-0',
    createdAt: Date.now() - (options.ageMs ?? 0),
    user: { name: 'Test', email: 'test@example.com', username: 'test' },
  });
}

/**
 * How many seconds the store will keep the session a cookie points at.
 */
function storedSeconds(cookies: FakeCookies): Promise<number> {
  return redis.ttl(`relay:session:${cookies.jar.get('relay_session')}`);
}

beforeEach(() => {
  idp = new FakeIdp();
  logged = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  idp.stop();
  logged.mockRestore();
});

afterAll(clearSessions);

describe('getValidSession', () => {
  test('returns a healthy session without touching the identity provider', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000);

    const session = await getValidSession(cookies);

    expect(session?.accessToken).toBe('access-0');
    expect(idp.tokenRequests).toHaveLength(0);
  });

  test('renews inside the skew window, before the token has actually expired', async () => {
    const cookies = fakeCookies();

    // Still valid by the clock, but not for long enough to survive the trip to
    // the backend, which is the case a bare comparison with now gets wrong.
    await seed(cookies, 10_000);

    const session = await getValidSession(cookies);

    expect(idp.tokenRequests).toHaveLength(1);
    expect(session?.accessToken).toBe('access-1');
  });

  test('renews with the rotated refresh token the next time, and not the spent one', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);

    await getValidSession(cookies);
    await refreshSession(cookies);

    // The second renewal reads the session back from the store, so this also
    // shows that the rotated token was written there.
    const presented = idp.tokenRequests.map((request) => request.get('refresh_token'));
    expect(presented).toEqual(['refresh-0', 'refresh-1']);
  });

  test('ends the session when there is no refresh token to renew with', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000, { refreshToken: undefined });

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(idp.tokenRequests).toHaveLength(0);
    expect(cookies.jar.size).toBe(0);
  });

  test('refuses to renew past the absolute cap', async () => {
    const cookies = fakeCookies();

    // Inside the idle window, but the session itself is older than the cap.
    await seed(cookies, -1000, { ageMs: 48 * 60 * 60 * 1000 });

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(idp.tokenRequests).toHaveLength(0);
  });

  test('ends the session when the refresh is rejected', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);
    idp.trouble = 'refuses';

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(cookies.jar.size).toBe(0);
  });

  test('uses the session another server renewed between this one reading it and taking the lock', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);
    const key = `relay:session:${cookies.jar.get('relay_session')}`;
    const renewed = { accessToken: 'access-elsewhere', expiresAt: Date.now() + 3_600_000, createdAt: Date.now() };

    // The first write this request makes is its attempt on the lock. The other
    // server's renewal is slipped in just ahead of it, lock already released.
    const set = redis.set.bind(redis);
    const attempt = spyOn(redis, 'set').mockImplementationOnce(async (...lock) => {
      await set(key, JSON.stringify(renewed), { EX: 3600 });

      return set(...lock);
    });

    const session = await getValidSession(cookies);
    attempt.mockRestore();

    // Refreshing here would present a token the other server already spent,
    // and the refusal would end the session.
    expect(session?.accessToken).toBe('access-elsewhere');
    expect(idp.tokenRequests).toHaveLength(0);
  });

  // The regression the lock exists for. A page load fires several requests at
  // once, and rotation means a second refresh presents a token the first has
  // already spent, which the provider refuses. It never reproduces by hand.
  test('concurrent callers produce exactly one token call', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);
    idp.delayMs = 150;

    const results = await Promise.all(Array.from({ length: 8 }, () => getValidSession(cookies)));

    expect(idp.tokenRequests).toHaveLength(1);

    // Every caller has to come away usable, and not only the one that won the
    // lock.
    for (const session of results) {
      expect(session?.accessToken).toBe('access-1');
    }
  });
});

// A provider that cannot be asked says nothing about the refresh token, so none
// of this may end the session.
describe('when the identity provider cannot be asked', () => {
  test('the session is kept, and renewed once the provider is back', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);

    idp.trouble = 'unavailable';
    const during = await getValidSession(cookies);
    idp.trouble = null;
    const after = await getValidSession(cookies);

    // Nothing to go on with while the provider was away, since the token had
    // already expired.
    expect(during).toBeNull();
    expect(after?.accessToken).toBe('access-1');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  test('the request goes on with the token it has while that still works', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 10_000);
    idp.trouble = 'unavailable';

    const session = await getValidSession(cookies);

    expect(session?.accessToken).toBe('access-0');
  });

  test('callers that waited on the renewal are let go as soon as it fails', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 10_000);
    idp.trouble = 'unavailable';
    idp.delayMs = 150;
    const started = Date.now();

    const results = await Promise.all(Array.from({ length: 8 }, () => getValidSession(cookies)));

    // Left to wait out the lock, they would be here for eight seconds.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(idp.tokenRequests).toHaveLength(1);

    for (const session of results) {
      expect(session?.accessToken).toBe('access-0');
    }
  });

  // Slow on purpose. The only way to see the deadline is to wait it out.
  test('a provider that never answers is given up on', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 10_000);
    idp.trouble = 'silent';
    const started = Date.now();

    const session = await getValidSession(cookies);

    expect(Date.now() - started).toBeLessThan(6_000);
    expect(session?.accessToken).toBe('access-0');
  }, 10_000);
});

describe('refreshSession', () => {
  test('renews whatever the stored expiry claims', async () => {
    const cookies = fakeCookies();

    // The backend refused a token this process believes is healthy, so the
    // stored expiry is not the thing to go by.
    await seed(cookies, 60 * 60 * 1000);

    const session = await refreshSession(cookies);

    expect(idp.tokenRequests).toHaveLength(1);
    expect(session?.accessToken).toBe('access-1');
  });

  test('declines when there is nothing to renew with', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000, { refreshToken: undefined });

    const session = await refreshSession(cookies);

    expect(session).toBeNull();
    expect(idp.tokenRequests).toHaveLength(0);
  });
});

describe('destroySession', () => {
  test('ends the session for anyone still holding its cookie, and returns what it held', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000);
    const copied = fakeCookies();
    copied.jar.set('relay_session', cookies.jar.get('relay_session') ?? '');

    const session = await destroySession(cookies);

    // What comes back is what lets signing out revoke the refresh token.
    expect(session?.refreshToken).toBe('refresh-0');
    expect(session?.idToken).toBe('id-0');
    expect(cookies.jar.size).toBe(0);
    expect(await getValidSession(copied)).toBeNull();
  });
});

// The windows are the ones setup.ts configures, an hour idle and a day at most.
describe('how long a session is kept', () => {
  test('for the idle window, while its cap is far off', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 5 * 60 * 1000);

    const seconds = await storedSeconds(cookies);

    expect(seconds).toBeGreaterThan(3590);
    expect(seconds).toBeLessThanOrEqual(3600);
  });

  test('never past its absolute cap', async () => {
    const cookies = fakeCookies();

    // Ten minutes short of a day old.
    await seed(cookies, 5 * 60 * 1000, { ageMs: (24 * 60 - 10) * 60 * 1000 });

    const seconds = await storedSeconds(cookies);

    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  test('only as long as its token lasts, when it cannot be renewed', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 30 * 60 * 1000, { refreshToken: undefined });

    const seconds = await storedSeconds(cookies);

    expect(seconds).toBeGreaterThan(1790);
    expect(seconds).toBeLessThanOrEqual(1800);
  });
});
