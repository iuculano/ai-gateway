import { randomBytes } from 'node:crypto';
import { connectRedis, redis } from '@repo/redis';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';

// Sessions live server-side in Valkey; the browser only ever holds an opaque
// random id. The access token never leaves the server in any form.
//
// Each entry point opens the connection first. @repo/redis constructs its
// client without connecting - importing it used to open a socket, which made
// the package unusable from a test - so somebody has to. The backend does it
// once at boot; this app has no equivalent startup hook, and connectRedis() is
// idempotent, so asking at the point of use costs an already-resolved promise.
const SESSION_COOKIE = 'relay_session';
const KEY_PREFIX = 'relay:session:';

export interface Session {
  /** The Zitadel access token forwarded to the backend by the proxy. */
  accessToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  /** Display-only profile from the ID token; authz always happens backend-side. */
  user: {
    name?: string;
    email?: string;
    username?: string;
  };
}

/**
 * Stores the session in Valkey (expiring with the access token) and hands
 * the browser an opaque id cookie pointing at it.
 */
export async function createSession(cookies: Cookies, session: Session): Promise<void> {
  await connectRedis();

  const id = randomBytes(32).toString('base64url');
  const ttl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));

  await redis.set(KEY_PREFIX + id, JSON.stringify(session), { EX: ttl });

  cookies.set(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: ttl,
  });
}

export async function readSession(cookies: Cookies): Promise<Session | null> {
  await connectRedis();

  const id = cookies.get(SESSION_COOKIE);
  if (!id) {
    return null;
  }

  const raw = await redis.get(KEY_PREFIX + id);
  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw) as Session;
    if (!session.accessToken || session.expiresAt <= Date.now()) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export async function destroySession(cookies: Cookies): Promise<void> {
  await connectRedis();

  const id = cookies.get(SESSION_COOKIE);
  if (id) {
    await redis.del(KEY_PREFIX + id);
  }
  cookies.delete(SESSION_COOKIE, { path: '/' });
}
