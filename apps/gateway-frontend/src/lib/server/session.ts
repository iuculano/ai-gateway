import { randomBytes } from 'node:crypto';
import { connectRedis, redis } from '@repo/redis';
import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { refreshTokens } from './oidc';

// Sessions live server-side in Valkey; the browser only ever holds an opaque
// random id. No token of any kind leaves the server.
//
// Each entry point opens the connection first. @repo/redis constructs its
// client without connecting - importing it used to open a socket, which made
// the package unusable from a test - so somebody has to. The backend does it
// once at boot; this app has no equivalent startup hook, and connectRedis() is
// idempotent, so asking at the point of use costs an already-resolved promise.
const SESSION_COOKIE = 'relay_session';
const KEY_PREFIX = 'relay:session:';
const LOCK_PREFIX = 'relay:session:refresh:';

/**
 * How early a token counts as expired.
 *
 * A token with two seconds left passes a bare `expiresAt > now` test, gets
 * attached to a request, and expires in flight - so the check has to happen
 * against a horizon rather than against the instant. This also absorbs clock
 * drift between this process and the backend, which validate `exp` against
 * different clocks.
 */
const EXPIRY_SKEW_MS = 60_000;

/** How long the refresh lock is held before it is assumed abandoned. */
const LOCK_TTL_MS = 10_000;

/** How long a loser of the refresh race waits for the winner's result. */
const LOCK_WAIT_MS = 8_000;
const LOCK_POLL_MS = 50;

/**
 * Idle window: how long a session survives without being used.
 *
 * Extended on every successful refresh, which is what makes expiry sliding
 * rather than fixed.
 */
function idleSeconds(): number {
  return Number(env.SESSION_IDLE_SECONDS ?? 60 * 60 * 8);
}

/**
 * Absolute cap: how long a session may live regardless of activity.
 *
 * The mitigation for keeping a long-lived credential server-side. Without it a
 * session that is used daily never ends, and a stolen session id is good
 * forever.
 */
function absoluteSeconds(): number {
  return Number(env.SESSION_ABSOLUTE_SECONDS ?? 60 * 60 * 24 * 7);
}

export interface Session {
  /** The access token forwarded to the backend by the proxy. */
  accessToken: string;
  /** Epoch milliseconds when the ACCESS TOKEN expires - not the session. */
  expiresAt: number;
  /**
   * Present only when the IDP issued one. Its absence is what makes every
   * renewal path below degrade to the previous behaviour: the session simply
   * ends when the access token does.
   */
  refreshToken?: string;
  /** Raw ID token, kept solely as `id_token_hint` for RP-initiated logout. */
  idToken?: string;
  /** Epoch milliseconds the session was first established, for the absolute cap. */
  createdAt: number;
  /** Display-only profile from the ID token; authz always happens backend-side. */
  user: {
    name?: string;
    email?: string;
    username?: string;
  };
}

interface SessionEntry {
  id: string;
  session: Session;
}

/**
 * How long this session's Valkey key and cookie should live.
 *
 * With a refresh token, the session outlives the access token and is bounded by
 * the idle window (and, further out, the absolute cap). Without one there is no
 * way to extend anything, so the session can only last as long as the token it
 * holds - which is exactly the behaviour this app had before refresh existed.
 */
function ttlSeconds(session: Session): number {
  if (!session.refreshToken) {
    return Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  }

  const remainingAbsolute = Math.floor((sessionStart(session) + absoluteSeconds() * 1000 - Date.now()) / 1000);

  return Math.max(60, Math.min(idleSeconds(), remainingAbsolute));
}

/**
 * When the session began, for sessions written before `createdAt` existed.
 *
 * A stored session predating this field would otherwise make every cap
 * calculation NaN - and `Math.max(60, NaN)` is NaN, which Valkey rejects as a
 * TTL, so the failure would be a write error rather than a wrong number.
 * Treating an unknown start as "now" errs towards keeping the session, which
 * matches how the rest of this module handles a shape it does not recognise.
 */
function sessionStart(session: Session): number {
  return typeof session.createdAt === 'number' ? session.createdAt : Date.now();
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
 * Stores a new session and hands the browser an opaque id cookie pointing at it.
 *
 * A fresh id on every login, so a pre-login id can never be promoted into an
 * authenticated one.
 */
export async function createSession(cookies: Cookies, session: Session): Promise<void> {
  await writeSession(cookies, randomBytes(32).toString('base64url'), session);
}

/**
 * Reads the stored session without regard for whether its token is still good.
 *
 * Clears the cookie whenever it points at nothing, so a browser holding a dead
 * id stops presenting it on every subsequent request.
 */
async function readEntry(cookies: Cookies): Promise<SessionEntry | null> {
  await connectRedis();

  const id = cookies.get(SESSION_COOKIE);
  if (!id) {
    return null;
  }

  const raw = await redis.get(KEY_PREFIX + id);
  if (!raw) {
    cookies.delete(SESSION_COOKIE, { path: '/' });
    return null;
  }

  try {
    const session = JSON.parse(raw) as Session;
    if (!session.accessToken) {
      cookies.delete(SESSION_COOKIE, { path: '/' });
      return null;
    }
    return { id, session };
  } catch {
    cookies.delete(SESSION_COOKIE, { path: '/' });
    return null;
  }
}

/** Whether the access token is expired, or close enough to count as expired. */
function needsRenewal(session: Session): boolean {
  return session.expiresAt - Date.now() <= EXPIRY_SKEW_MS;
}

/** Whether the session has outlived its absolute cap, which no refresh may extend. */
function pastAbsoluteCap(session: Session): boolean {
  return Date.now() >= sessionStart(session) + absoluteSeconds() * 1000;
}

/**
 * The session for this request, renewed if the access token is at or near
 * expiry.
 *
 * Renewal happens BEFORE the token is used rather than in response to a 401,
 * which is what keeps the common expiry case from costing a failed request. It
 * does not replace the reactive path in the proxy: expiry is the only failure
 * this can predict, and revocation, JWKS rotation, and an evicted session all
 * arrive as a 401 on a token that looked perfectly valid here.
 */
export async function getValidSession(cookies: Cookies): Promise<Session | null> {
  const entry = await readEntry(cookies);
  if (!entry) {
    return null;
  }

  if (pastAbsoluteCap(entry.session)) {
    await destroySession(cookies);
    return null;
  }

  if (!needsRenewal(entry.session)) {
    return entry.session;
  }

  if (!entry.session.refreshToken) {
    // Nothing to renew with: this is a pre-refresh session, or the IDP never
    // issued one. Expired means gone, exactly as before.
    await destroySession(cookies);
    return null;
  }

  return renew(cookies, entry);
}

/**
 * Forces a renewal regardless of what `expiresAt` claims.
 *
 * The reactive path: the backend rejected a token this process believed was
 * valid, so the stored expiry is not the thing to consult.
 */
export async function refreshSession(cookies: Cookies): Promise<Session | null> {
  const entry = await readEntry(cookies);
  if (!entry?.session.refreshToken || pastAbsoluteCap(entry.session)) {
    return null;
  }

  return renew(cookies, entry);
}

/**
 * Renews under a lock, so concurrent requests produce one token call.
 *
 * Zitadel rotates refresh tokens: the response carries a new one and invalidates
 * the old. A dashboard page load fires several requests at once, so without this
 * the first refresh succeeds and every other one presents a rotated-out token,
 * receives invalid_grant, and destroys the session at the exact moment it was
 * supposed to be renewed. That failure only appears under real concurrency,
 * which is why it is designed for rather than discovered.
 */
async function renew(cookies: Cookies, entry: SessionEntry): Promise<Session | null> {
  await connectRedis();

  const lockKey = LOCK_PREFIX + entry.id;
  const acquired = await redis.set(lockKey, '1', { NX: true, PX: LOCK_TTL_MS });

  if (!acquired) {
    return waitForRenewal(entry);
  }

  try {
    const tokens = await refreshTokens(entry.session.refreshToken as string);

    const next: Session = {
      ...entry.session,
      accessToken: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      // Rotation means the old one is already dead. Falling back to it would
      // store a token guaranteed to fail on the next renewal.
      refreshToken: tokens.refreshToken ?? entry.session.refreshToken,
      idToken: tokens.idToken ?? entry.session.idToken,
    };

    // Persisted BEFORE it is returned or used. A crash between the IDP issuing
    // a rotated token and this write orphans the session with no way back.
    await writeSession(cookies, entry.id, next);

    return next;
  } catch {
    // invalid_grant and friends are terminal - the refresh token is spent,
    // revoked, or expired, and only a fresh login recovers.
    await destroySession(cookies);
    return null;
  } finally {
    await redis.del(lockKey);
  }
}

/**
 * Waits for whoever holds the lock to publish a new access token.
 *
 * Polls the session key rather than refreshing, because a second refresh with
 * the same rotated token is precisely the failure the lock exists to prevent.
 * On timeout it returns whatever is stored: a stale token costs one 401 and one
 * reactive retry, where refreshing anyway would cost the session.
 */
async function waitForRenewal(entry: SessionEntry): Promise<Session | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));

    const raw = await redis.get(KEY_PREFIX + entry.id);
    if (!raw) {
      // The winner's refresh failed and took the session with it.
      return null;
    }

    try {
      const session = JSON.parse(raw) as Session;
      if (session.accessToken !== entry.session.accessToken) {
        return session;
      }
    } catch {
      return null;
    }
  }

  return entry.session;
}

/**
 * Clears the local session and returns what it held.
 *
 * The return value is what lets logout revoke the refresh token and end the
 * IDP's own session; every other caller ignores it.
 */
export async function destroySession(cookies: Cookies): Promise<Session | null> {
  await connectRedis();

  const id = cookies.get(SESSION_COOKIE);
  let session: Session | null = null;

  if (id) {
    const raw = await redis.get(KEY_PREFIX + id);
    if (raw) {
      try {
        session = JSON.parse(raw) as Session;
      } catch {
        session = null;
      }
    }

    await redis.del(KEY_PREFIX + id);
  }

  cookies.delete(SESSION_COOKIE, { path: '/' });

  return session;
}
