import { randomUUID } from 'node:crypto';
import { redis } from '@repo/redis';
import { expect, test } from './api-mock';
import { seedSession, sessionCookie } from './sessions';

test.use({ storageState: { cookies: [], origins: [] } });

test.afterAll(async () => {
  if (redis.isOpen) {
    await redis.quit();
  }
});

test('signing out ends the session, so the next page asks to sign in again', async ({ page, context }) => {
  // A session of its own. Signing out of the one the other tests share would
  // sign every one of them out with it.
  const id = `playwright-sign-out-${randomUUID()}`;
  await seedSession(id);
  await context.addCookies([sessionCookie(id)]);
  await page.goto('/keys');

  await page.getByTitle('Sign out').click();
  await page.waitForURL('**/auth/login');

  const response = await page.request.get('/keys', { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe('/auth/login?redirect_to=%2Fkeys');
});
