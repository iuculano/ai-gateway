import { expect, test } from './api-mock';

const USERS = '/api/analytics/users';
const TOKENS = '/api/analytics/tokens';
const SESSION_POSITIONS = '/api/analytics/session-positions';

const ADA = { user_id: 'ada', requests: 12, tokens: 3400, cost_total: 1.5 };
const GRACE = { user_id: 'grace', requests: 4, tokens: 900, cost_total: 0.25 };

// Users

test('picking a user narrows the pane to them and keeps the pick in the URL', async ({ page, api }) => {
  api.post(USERS, { json: { active_users: 2, cost_percentiles: [], users: [ADA, GRACE] } });
  const grace = page.getByRole('navigation', { name: 'Users' }).getByRole('link', { name: /grace/ });

  await page.goto('/analytics/users');
  await grace.click();

  await expect(page).toHaveURL('/analytics/users?user=grace');
  await expect(grace).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => api.matching('POST', TOKENS).at(-1)?.body).toMatchObject({ user_id: 'grace' });
});

test('a user who is not listed can be opened by id', async ({ page, api }) => {
  api.post(USERS, { json: { active_users: 1, cost_percentiles: [], users: [ADA] } });
  const users = page.getByRole('navigation', { name: 'Users' });
  const lookup = users.getByLabel('Find a user by id');

  await page.goto('/analytics/users');
  await lookup.fill('  someone-else  ');
  await lookup.press('Enter');

  await expect(page).toHaveURL('/analytics/users?user=someone-else');
  await expect(users.getByRole('link', { name: /someone-else/ })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => api.matching('POST', TOKENS).at(-1)?.body).toMatchObject({ user_id: 'someone-else' });
});

// Sessions

test('a session that is not listed can be opened by id', async ({ page, api }) => {
  const lookup = page.getByRole('navigation', { name: 'Sessions' }).getByLabel('Find a session by id');

  await page.goto('/analytics/sessions');
  await lookup.fill('checkout-42');
  await lookup.press('Enter');

  await expect(page).toHaveURL('/analytics/sessions?session=checkout-42');
  await expect
    .poll(() => api.matching('POST', SESSION_POSITIONS).at(-1)?.body)
    .toMatchObject({ session_id: 'checkout-42' });
});
