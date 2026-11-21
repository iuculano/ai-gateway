import { connectRedis, redis } from '@repo/redis';
import type { Session } from '../../src/lib/server/session';

const SESSION_SECONDS = 60 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Stores a signed-in session under an id, where the app will find it.
 */
export async function seedSession(id: string): Promise<void> {
  const now = Date.now();
  const session: Session = {
    accessToken: 'playwright-access-token',
    expiresAt: now + SESSION_SECONDS * 1000,
    createdAt: now,
    user: {
      name: 'Playwright User',
      email: 'playwright@example.test',
      username: 'playwright',
    },
  };

  let connectionTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      connectRedis(),
      new Promise<never>((_, reject) => {
        connectionTimeout = setTimeout(() => {
          redis.destroy();
          reject(new Error(`Could not connect to the E2E session store within ${REDIS_CONNECT_TIMEOUT_MS}ms`));
        }, REDIS_CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
  }

  await redis.set(`relay:session:${id}`, JSON.stringify(session), { EX: SESSION_SECONDS });
}

/**
 * The cookie that points a browser at a seeded session.
 */
export function sessionCookie(id: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax';
} {
  return {
    name: 'relay_session',
    value: id,
    domain: '127.0.0.1',
    path: '/',
    expires: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
}
