import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { connectRedis, redis } from '@repo/redis';
import type { Session } from '../../src/lib/server/session';
import { authStatePath } from './paths';

const SESSION_ID = 'playwright-session';
const SESSION_SECONDS = 60 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

export default async function globalSetup(_config: FullConfig): Promise<void> {
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
    if (connectionTimeout) clearTimeout(connectionTimeout);
  }

  await redis.set(`relay:session:${SESSION_ID}`, JSON.stringify(session), { EX: SESSION_SECONDS });
  await redis.quit();

  await mkdir(dirname(authStatePath), { recursive: true });
  await writeFile(
    authStatePath,
    JSON.stringify({
      cookies: [
        {
          name: 'relay_session',
          value: SESSION_ID,
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(now / 1000) + SESSION_SECONDS,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}
