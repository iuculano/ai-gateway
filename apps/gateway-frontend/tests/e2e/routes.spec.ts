import { expect, test } from './api-mock';

// Each page is opened with no data. The `api` fixture fails a test for any
// request without a mock and any error the page throws, which is what makes a
// plain visit worth asserting on.
const ROUTES = [
  { path: '/overview', section: 'Overview', ready: 'Nothing lives here yet.' },
  { path: '/playground', section: 'Playground', ready: 'Nothing sent yet.' },
  { path: '/playground/decisions', section: 'Playground', ready: 'Run a request to see the answers here.' },
  { path: '/prompts', section: 'Prompts', ready: 'No prompts yet' },
  { path: '/models', section: 'Models', ready: 'No providers in the catalog' },
  { path: '/logs', section: 'Logs', ready: 'No logs recorded yet' },
  { path: '/traces', section: 'Traces', ready: 'No traces recorded yet' },
  { path: '/analytics', section: 'Analytics', ready: 'No requests in this window.' },
  { path: '/analytics/users', section: 'Analytics', ready: 'No requests tagged with a user.' },
  { path: '/analytics/sessions', section: 'Analytics', ready: 'No sessions in this window.' },
  { path: '/analytics/savings', section: 'Analytics', ready: 'No priced spend in this window.' },
  { path: '/audit', section: 'Audit log', ready: 'No audit events recorded yet' },
  { path: '/keys', section: 'API Keys', ready: 'No API keys yet' },
  { path: '/webhooks', section: 'Webhooks', ready: 'No webhooks yet' },
  { path: '/settings', section: 'Settings', ready: 'No settings API exists yet' },
];

for (const route of ROUTES) {
  test(`${route.path} loads with no data`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.locator('main').getByRole('heading', { name: route.section, exact: true })).toBeVisible();
    await expect(page.locator('header').getByText(route.section, { exact: true })).toBeVisible();
    await expect(page.getByText(route.ready).first()).toBeVisible();
  });
}

test('the shell shows who is signed in', async ({ page }) => {
  await page.goto('/keys');

  await expect(page.getByText('Playwright User', { exact: true })).toBeVisible();
});

test('a session that expires mid-use sends the reader to sign in and back to the same page', async ({ page, api }) => {
  api.get('/api/api-keys', { status: 401, json: { error: { code: 401, message: 'Not authenticated.' } } });

  // The real login route goes on to the identity provider, which these tests
  // do not have.
  await page.route('**/auth/login**', (route) => route.fulfill({ body: 'Sign in' }));

  await page.goto('/keys?status=active');

  await expect(page).toHaveURL('/auth/login?redirect_to=%2Fkeys%3Fstatus%3Dactive');
});
