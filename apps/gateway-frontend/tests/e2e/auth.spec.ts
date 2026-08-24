import { expect, test } from './api-mock';

test.use({ storageState: { cookies: [], origins: [] } });

test('protected routes redirect an unauthenticated visitor and preserve the destination', async ({ request }) => {
  const response = await request.get('/keys?status=active', { maxRedirects: 0 });

  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe('/auth/login?redirect_to=%2Fkeys%3Fstatus%3Dactive');
});
