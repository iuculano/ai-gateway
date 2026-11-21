import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { redis } from '@repo/redis';
import { authStatePath } from './paths';
import { seedSession, sessionCookie } from './sessions';

const SESSION_ID = 'playwright-session';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  await seedSession(SESSION_ID);
  await redis.quit();

  await mkdir(dirname(authStatePath), { recursive: true });
  await writeFile(authStatePath, JSON.stringify({ cookies: [sessionCookie(SESSION_ID)], origins: [] }));
}
