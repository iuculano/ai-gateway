import { expect, test } from './api-mock';
import { CATALOGUE, registerEmptyApp } from './fixtures';

test('the authenticated shell loads every primary frontend route', async ({ page, api }) => {
  registerEmptyApp(api);

  let catalogueAttempts = 0;
  api.get('/api/providers', () => {
    catalogueAttempts += 1;
    if (catalogueAttempts === 1) {
      return {
        status: 503,
        json: { error: { code: 503, message: 'Catalogue temporarily unavailable.' } },
      };
    }

    return { json: { data: CATALOGUE } };
  });

  await test.step('a representative API failure can be retried', async () => {
    await page.goto('/models');
    await expect(page.getByText('Catalogue temporarily unavailable.')).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
    expect(catalogueAttempts).toBe(2);
  });

  const routes = [
    {
      path: '/overview',
      heading: 'Overview',
      breadcrumb: 'Overview',
      ready: "i don't know what to put on this page yet",
    },
    { path: '/playground', heading: 'Playground', breadcrumb: 'Playground', ready: 'Nothing sent yet.' },
    { path: '/prompts', heading: 'Prompts', breadcrumb: 'Prompts', ready: 'No prompts yet' },
    { path: '/logs', heading: 'Logs', breadcrumb: 'Logs', ready: 'No logs recorded yet' },
    { path: '/analytics', heading: 'Analytics', breadcrumb: 'Analytics', ready: 'No requests in this window.' },
    { path: '/audit', heading: 'Audit log', breadcrumb: 'Audit log', ready: 'No audit events recorded yet' },
    { path: '/keys', heading: 'API Keys', breadcrumb: 'API Keys', ready: 'No API keys yet' },
    { path: '/webhooks', heading: 'Webhooks', breadcrumb: 'Webhooks', ready: 'No webhooks yet' },
    { path: '/settings', heading: 'Settings', breadcrumb: 'Settings', ready: 'Preview.' },
  ] as const;

  for (const route of routes) {
    await test.step(route.path, async () => {
      await page.goto(route.path);
      await expect(page.locator('main').getByRole('heading', { name: route.heading, exact: true })).toBeVisible();
      await expect(page.locator('header').getByText(route.breadcrumb, { exact: true })).toBeVisible();
      await expect(page.getByText(route.ready, { exact: false }).first()).toBeVisible();
      await expect(page.getByText('Playwright User', { exact: true })).toBeVisible();
    });
  }
});
