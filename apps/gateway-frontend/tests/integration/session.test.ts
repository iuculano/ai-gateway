import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Cookies } from '@sveltejs/kit';

/**
 * Exercises the real session module against a real Valkey.
 *
 * The behaviour worth testing here is coordination - one token call per expiry,
 * a rotated token persisted before it is used, a failed refresh taking the
 * session with it - and none of that survives being reimplemented in a double.
 * So the module under test is the actual one, with only the IDP faked.
 */

const OIDC_PATH = new URL('../../src/lib/server/oidc.ts', import.meta.url).pathname;

let refreshCalls = 0;
let refreshDelayMs = 0;
let refreshFails = false;
let issued = 0;

mock.module(OIDC_PATH, () => ({
  refreshTokens: async () => {
    refreshCalls += 1;

    // A real token endpoint is a network round-trip. Without some latency every
    // "concurrent" call would resolve before the next one started and the lock
    // would never actually be contended.
    if (refreshDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
    }

    if (refreshFails) {
      throw new Error('invalid_grant');
    }

    issued += 1;
    return {
      accessToken: `access-${issued}`,
      expiresIn: 3600,
      refreshToken: `refresh-${issued}`,
      idToken: `id-${issued}`,
      idTokenClaims: {},
    };
  },
  revokeRefreshToken: async () => {},
  buildEndSessionUrl: async () => null,
}));

const { createSession, getValidSession, refreshSession, destroySession } = await import('../../src/lib/server/session');
const { redis, connectRedis } = await import('@repo/redis');

/** Enough of SvelteKit's Cookies for the session module, backed by a map. */
function fakeCookies(): Cookies & { jar: Map<string, string> } {
  const jar = new Map<string, string>();

  return {
    jar,
    get: (name: string) => jar.get(name),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    serialize: () => '',
  } as unknown as Cookies & { jar: Map<string, string> };
}

const baseUser = { name: 'Test', email: 'test@example.com', username: 'test' };

/** Writes a session whose access token expires at a chosen offset from now. */
async function seed(cookies: Cookies, expiresInMs: number, options: { refreshToken?: string; ageMs?: number } = {}) {
  await createSession(cookies, {
    accessToken: 'access-0',
    expiresAt: Date.now() + expiresInMs,
    refreshToken: 'refreshToken' in options ? options.refreshToken : 'refresh-0',
    idToken: 'id-0',
    createdAt: Date.now() - (options.ageMs ?? 0),
    user: baseUser,
  });
}

beforeEach(() => {
  refreshCalls = 0;
  refreshDelayMs = 0;
  refreshFails = false;
  issued = 0;
});

afterAll(async () => {
  await connectRedis();
  await redis.flushDb();
});

describe('getValidSession', () => {
  test('returns a healthy session without touching the IDP', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000);

    const session = await getValidSession(cookies);

    expect(session?.accessToken).toBe('access-0');
    expect(refreshCalls).toBe(0);
  });

  test('renews inside the skew window, before the token has actually expired', async () => {
    const cookies = fakeCookies();

    // Still valid by the clock, but not for long enough to survive the trip to
    // the backend - the case a bare `expiresAt > now` check gets wrong.
    await seed(cookies, 10_000);

    const session = await getValidSession(cookies);

    expect(refreshCalls).toBe(1);
    expect(session?.accessToken).toBe('access-1');
  });

  test('persists the rotated refresh token rather than the spent one', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);

    const session = await getValidSession(cookies);

    expect(session?.refreshToken).toBe('refresh-1');

    // And it survives a re-read: a rotated token held only in memory is a
    // session that dies on the next process.
    const reread = await getValidSession(cookies);
    expect(reread?.refreshToken).toBe('refresh-1');
  });

  test('ends the session when there is no refresh token to renew with', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000, { refreshToken: undefined });

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(refreshCalls).toBe(0);
    expect(cookies.jar.size).toBe(0);
  });

  test('refuses to renew past the absolute cap', async () => {
    const cookies = fakeCookies();

    // Inside the idle window, but the session itself is older than the cap.
    await seed(cookies, -1000, { ageMs: 48 * 60 * 60 * 1000 });

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(refreshCalls).toBe(0);
  });

  test('ends the session when the refresh is rejected', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);
    refreshFails = true;

    const session = await getValidSession(cookies);

    expect(session).toBeNull();
    expect(cookies.jar.size).toBe(0);
  });

  /**
   * The regression this whole design exists for.
   *
   * A dashboard page load fires several requests at once. Rotation means the
   * second refresh presents a token the first already spent, so without the
   * lock the IDP answers invalid_grant and the session dies at the exact moment
   * it was supposed to be renewed. It never reproduces by hand.
   */
  test('concurrent callers produce exactly one token call', async () => {
    const cookies = fakeCookies();
    await seed(cookies, -1000);
    refreshDelayMs = 150;

    const results = await Promise.all(Array.from({ length: 8 }, () => getValidSession(cookies)));

    expect(refreshCalls).toBe(1);

    // Every caller has to come away usable, not just the one that won the lock.
    for (const session of results) {
      expect(session?.accessToken).toBe('access-1');
    }
  });
});

describe('sessions written before the refresh fields existed', () => {
  test('are usable, and are not mistaken for having outlived the cap', async () => {
    const cookies = fakeCookies();
    await connectRedis();

    // Exactly the shape this app stored before refresh tokens: no createdAt, no
    // refreshToken. A NaN cap calculation here would reject a live session, and
    // a NaN TTL would fail the write outright rather than merely be wrong.
    const id = 'legacy-session-id';
    cookies.set('relay_session', id, { path: '/' });
    await redis.set(
      `relay:session:${id}`,
      JSON.stringify({ accessToken: 'legacy', expiresAt: Date.now() + 60 * 60 * 1000, user: baseUser }),
      { EX: 3600 },
    );

    const session = await getValidSession(cookies);

    expect(session?.accessToken).toBe('legacy');
    expect(refreshCalls).toBe(0);
  });

  test('end when their access token does, having nothing to renew with', async () => {
    const cookies = fakeCookies();
    await connectRedis();

    const id = 'legacy-expired-id';
    cookies.set('relay_session', id, { path: '/' });
    await redis.set(
      `relay:session:${id}`,
      JSON.stringify({ accessToken: 'legacy', expiresAt: Date.now() - 1000, user: baseUser }),
      { EX: 3600 },
    );

    expect(await getValidSession(cookies)).toBeNull();
    expect(refreshCalls).toBe(0);
  });
});

describe('refreshSession', () => {
  test('renews regardless of what the stored expiry claims', async () => {
    const cookies = fakeCookies();

    // The reactive path: the backend rejected a token this process believes is
    // healthy, so the stored expiry is not the thing to consult.
    await seed(cookies, 60 * 60 * 1000);

    const session = await refreshSession(cookies);

    expect(refreshCalls).toBe(1);
    expect(session?.accessToken).toBe('access-1');
  });

  test('declines when there is nothing to renew with', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000, { refreshToken: undefined });

    expect(await refreshSession(cookies)).toBeNull();
    expect(refreshCalls).toBe(0);
  });
});

describe('destroySession', () => {
  test('returns what it cleared, so logout can revoke it', async () => {
    const cookies = fakeCookies();
    await seed(cookies, 60 * 60 * 1000);

    const session = await destroySession(cookies);

    expect(session?.refreshToken).toBe('refresh-0');
    expect(session?.idToken).toBe('id-0');
    expect(cookies.jar.size).toBe(0);
    expect(await getValidSession(cookies)).toBeNull();
  });
});
