import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectRedis, redis } from '@repo/redis';
import type { Cookies } from '@sveltejs/kit';
import { GrantRefused, PROVIDER_TIMEOUT_MS, refreshTokens, type UserProfile } from '#lib/server/oidc.ts';
import { dev } from '$app/env';
import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS } from '$app/env/private';

// Sessions are kept in Valkey and the browser holds only a random id, so no
// token of any kind leaves the server.
//
// Each way in opens the connection first. The redis package builds its client
// without connecting and connectRedis() is idempotent, so asking where the
// client is used costs a promise that has already resolved.
const SESSION_COOKIE = 'relay_session';
const KEY_PREFIX = 'relay:session:';
const LOCK_PREFIX = 'relay:session:refresh:';

// How early a token counts as expired. One with two seconds left would pass a
// bare comparison, be attached to a request and expire on the way. The margin
// also absorbs drift between this clock and the backend's.
const EXPIRY_SKEW_MS = 60_000;

// A renewal is at most two calls to the provider, one for its endpoints and one
// for the tokens. A request that lost the race for the lock waits that long on
// the winner, and the lock outlasts it by a margin, so that it can never lapse
// while its holder is still at work and let a second renewal start.
const LOCK_WAIT_MS = 2 * PROVIDER_TIMEOUT_MS;
const LOCK_TTL_MS = LOCK_WAIT_MS + 2_000;
const LOCK_POLL_MS = 50;

export interface Session {
  /**
   * The access token the proxy forwards to the backend.
   */
  accessToken: string;

  /**
   * When the access token expires, in epoch milliseconds. The session itself
   * can outlive it.
   */
  expiresAt: number;

  /**
   * Present only when the identity provider issued one. Without it the session
   * ends when its access token does.
   */
  refreshToken?: string;

  /**
   * The raw ID token, kept only to name the session when signing out of the
   * identity provider.
   */
  idToken?: string;

  /**
   * When the session began, in epoch milliseconds, for the absolute cap.
   */
  createdAt: number;

  /**
   * For display only. Authorization always happens in the backend.
   */
  user: UserProfile;
}

interface SessionEntry {
  id: string;
  session: Session;
}

// The adapter stops HTTP on shutdown. Closing this connection too lets the
// container exit without waiting out Docker's kill timeout.
if (!dev) {
  process.once('sveltekit:shutdown', () => {
    if (redis.isOpen) {
      redis.destroy();
    }
  });
}

/**
 * When the session must end however much it is used. Without a cap, a session
 * used every day never ends and a stolen id is good forever.
 */
function capEnd(session: Session): number {
  return session.createdAt + Number(SESSION_ABSOLUTE_SECONDS ?? 60 * 60 * 24 * 7) * 1000;
}

/**
 * How long the session's key and cookie should live, in seconds.
 */
function ttlSeconds(session: Session): number {
  // With nothing to renew it with, the session lasts as long as the token it
  // holds.
  if (!session.refreshToken) {
    return Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  }

  // Every renewal writes the idle window again, which is what makes it slide.
  const idle = Number(SESSION_IDLE_SECONDS ?? 60 * 60 * 8);
  const untilCap = Math.floor((capEnd(session) - Date.now()) / 1000);

  return Math.max(60, Math.min(idle, untilCap));
}

/**
 * A stored value as a session, or null when there is nothing usable in it.
 */
function parse(raw: string | null): Session | null {
  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw) as Session;

    return session.accessToken ? session : null;
  } catch {
    return null;
  }
}

async function writeSession(cookies: Cookies, id: string, session: Session): Promise<void> {
  await connectRedis();

  const ttl = ttlSeconds(session);

  await redis.set(KEY_PREFIX + id, JSON.stringify(session), { EX: ttl });

  cookies.set(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: ttl,
  });
}

/**
 * Stores a new session and gives the browser a cookie that points at it.
 */
export async function createSession(cookies: Cookies, session: Session): Promise<void> {
  // A fresh id every time, so that one from before signing in can never become
  // a signed-in one.
  await writeSession(cookies, randomBytes(32).toString('base64url'), session);
}

/**
 * The session the request's cookie points at, whether or not its token is
 * still good.
 */
async function readEntry(cookies: Cookies): Promise<SessionEntry | null> {
  const id = cookies.get(SESSION_COOKIE);

  if (!id) {
    return null;
  }

  await connectRedis();

  const session = parse(await redis.get(KEY_PREFIX + id));

  // A cookie that points at nothing is cleared, so that the browser stops
  // presenting it.
  if (!session) {
    cookies.delete(SESSION_COOKIE, { path: '/' });

    return null;
  }

  return { id: id, session: session };
}

/**
 * The session as it is, for as long as its access token has not expired.
 */
function unlessExpired(session: Session): Session | null {
  return session.expiresAt > Date.now() ? session : null;
}

/**
 * Waits for whoever holds the renewal lock, and returns the session they
 * stored or, when they could not renew, the one this request already had.
 */
async function waitForRenewal(entry: SessionEntry): Promise<Session | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;

  // Polled and never refreshed from here, because a second refresh with the
  // same token is the failure the lock exists to prevent.
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_MS);

    const [stored, lock] = await redis.mGet([KEY_PREFIX + entry.id, LOCK_PREFIX + entry.id]);
    const session = parse(stored ?? null);

    // Gone, so the provider refused the winner and the session went with it.
    if (!session) {
      return null;
    }

    if (session.accessToken !== entry.session.accessToken) {
      return session;
    }

    // The lock is released and the token is still the old one, so the winner
    // could not reach the provider and there is nothing more to wait for.
    if (!lock) {
      break;
    }
  }

  return unlessExpired(entry.session);
}

/**
 * Renews under a lock, so that requests arriving together make one token call
 * between them.
 */
async function renew(cookies: Cookies, entry: SessionEntry, refreshToken: string): Promise<Session | null> {
  // The identity provider rotates refresh tokens, so a second call with the
  // same one is refused, and that refusal would end the session at the moment
  // it was meant to be renewed. A page load fires several requests at once,
  // which is how two calls would come to hold the same token.
  const lockKey = LOCK_PREFIX + entry.id;
  const acquired = await redis.set(lockKey, '1', { NX: true, PX: LOCK_TTL_MS });

  if (!acquired) {
    return waitForRenewal(entry);
  }

  try {
    // Read again now that the lock is held. Another request can have renewed
    // between this one reading the session and taking the lock, and then the
    // refresh token this one read is already spent.
    const current = parse(await redis.get(KEY_PREFIX + entry.id));

    if (!current || current.accessToken !== entry.session.accessToken) {
      return current;
    }

    const tokens = await refreshTokens(refreshToken);
    const next: Session = {
      ...entry.session,
      accessToken: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      refreshToken: tokens.refreshToken ?? refreshToken,
      idToken: tokens.idToken ?? entry.session.idToken,
    };

    // Stored before it is returned. A rotated token lost between the provider
    // issuing it and this write leaves the session with no way back.
    await writeSession(cookies, entry.id, next);

    return next;
  } catch (error) {
    // A refused refresh token is spent, revoked or expired, and only signing in
    // again recovers.
    if (error instanceof GrantRefused) {
      await destroySession(cookies);

      return null;
    }

    // Anything else says nothing about the token, only that the provider could
    // not be asked. The session is kept, so that the next request can try
    // again, and this one goes on with the token it has while that still works.
    console.error('Session renewal failed', error);

    return unlessExpired(entry.session);
  } finally {
    await redis.del(lockKey);
  }
}

/**
 * The session for this request, renewed first when its access token is at or
 * near expiry.
 */
export async function getValidSession(cookies: Cookies): Promise<Session | null> {
  const entry = await readEntry(cookies);

  if (!entry) {
    return null;
  }

  const session = entry.session;

  // No renewal may extend a session past its cap.
  if (Date.now() >= capEnd(session)) {
    await destroySession(cookies);

    return null;
  }

  // Renewed before the token is used and not after a 401, so that the common
  // case of plain expiry never costs a refused request.
  if (session.expiresAt - Date.now() > EXPIRY_SKEW_MS) {
    return session;
  }

  if (!session.refreshToken) {
    await destroySession(cookies);

    return null;
  }

  return renew(cookies, entry, session.refreshToken);
}

/**
 * Renews whatever the stored expiry says, for when the backend has refused a
 * token that looked valid here.
 */
export async function refreshSession(cookies: Cookies): Promise<Session | null> {
  const entry = await readEntry(cookies);

  if (!entry?.session.refreshToken || Date.now() >= capEnd(entry.session)) {
    return null;
  }

  return renew(cookies, entry, entry.session.refreshToken);
}

/**
 * Ends the session and returns what it held, which is what lets signing out
 * revoke the refresh token and end the identity provider's session too.
 */
export async function destroySession(cookies: Cookies): Promise<Session | null> {
  const id = cookies.get(SESSION_COOKIE);

  cookies.delete(SESSION_COOKIE, { path: '/' });

  if (!id) {
    return null;
  }

  await connectRedis();

  return parse(await redis.getDel(KEY_PREFIX + id));
}
