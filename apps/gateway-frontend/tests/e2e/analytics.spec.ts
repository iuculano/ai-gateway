import type { SeriesPoint, SeriesResponse, SessionsResponse } from '../../src/lib/api/analytics';
import { expect, type RecordedApiRequest, test } from './api-mock';
import { IDS } from './fixtures';

const SERIES = '/api/analytics/series';
const USERS = '/api/analytics/users';
const TOKENS = '/api/analytics/tokens';
const SESSIONS = '/api/analytics/sessions';
const SESSION_POSITIONS = '/api/analytics/session-positions';
const SESSION_DISTRIBUTION = '/api/analytics/session-distribution';

const ADA = { user_id: 'ada', requests: 12, tokens: 3400, cost_total: 1.5 };
const GRACE = { user_id: 'grace', requests: 4, tokens: 900, cost_total: 0.25 };

const MONDAY = '2026-11-16T00:00:00.000Z';
const TUESDAY = '2026-11-17T00:00:00.000Z';

// This window, as each grouping the overview asks for. 200 requests, of which
// 10 failed and 40 are still in flight.
const THIS_WINDOW: Record<string, Partial<SeriesPoint>[]> = {
  '': [{ requests: 200, total_tokens: 9_000, cost_total: 30, median_latency_ms: 300 }],
  status: [
    { status: 'complete', requests: 150 },
    { status: 'incomplete', requests: 40 },
    { status: 'failed', requests: 10 },
  ],
  bucket: [
    { bucket: MONDAY, requests: 80, cost_total: 20 },
    { bucket: TUESDAY, requests: 120, cost_total: 30 },
  ],
  'bucket,provider': [
    { bucket: MONDAY, provider: 'openai', requests: 80, cost_total: 20 },
    { bucket: TUESDAY, provider: 'openai', requests: 90, cost_total: 10 },
    { bucket: TUESDAY, provider: 'anthropic', requests: 30, cost_total: 20 },
  ],
  actor: [
    { actor_type: 'user', actor_id: IDS.actor, requests: 160, cost_total: 10 },
    { actor_type: 'system', actor_id: null, requests: 40, cost_total: 40 },
  ],
  'bucket,status': [
    { bucket: MONDAY, status: 'complete', requests: 80 },
    { bucket: TUESDAY, status: 'complete', requests: 70 },
    { bucket: TUESDAY, status: 'incomplete', requests: 40 },
    { bucket: TUESDAY, status: 'failed', requests: 10 },
  ],
};

// The window before, with half the traffic and the same error rate.
const WINDOW_BEFORE: Record<string, Partial<SeriesPoint>[]> = {
  '': [{ requests: 100, total_tokens: 9_000, cost_total: 15, median_latency_ms: 300 }],
  status: [{ status: 'failed', requests: 5 }],
  actor: [{ actor_type: 'user', actor_id: IDS.actor, requests: 100, cost_total: 4 }],
};

/**
 * Answers the overview's two requests from the windows above, and anything
 * else, such as the forecast, with no data.
 */
function overviewSeries(request: RecordedApiRequest): SeriesResponse {
  const body = request.body as { groupings: string[][] };
  let window: Record<string, Partial<SeriesPoint>[]> = {};

  if (body.groupings.length === 8) {
    window = THIS_WINDOW;
  } else if (body.groupings.length === 4) {
    window = WINDOW_BEFORE;
  }

  return {
    interval: 'day',
    groupings: body.groupings.map((group_by) => ({ group_by: group_by, points: window[group_by.join(',')] ?? [] })),
  } as SeriesResponse;
}

// Overview

test('the overview reads its headline figures off the window and compares them with the one before', async ({
  page,
  api,
}) => {
  api.post(SERIES, (request) => ({ json: overviewSeries(request) }));
  const main = page.getByRole('main');

  await page.goto('/analytics');

  // Failures over every request. The 40 in flight are reported beside the
  // rate and not inside it.
  await expect(main.getByText('5.00%', { exact: true })).toBeVisible();
  await expect(main.getByText('20.00% in flight', { exact: true })).toBeVisible();
  await expect(main.getByText('$0.15', { exact: true })).toBeVisible();

  // Requests and spend doubled, and the error rate and cost per request held.
  await expect(main.getByText('↑ 100%', { exact: true })).toHaveCount(2);
  await expect(main.getByText('0%', { exact: true })).toHaveCount(4);
});

test('the overview draws traffic, providers and callers from the same window', async ({ page, api }) => {
  api.post(SERIES, (request) => ({ json: overviewSeries(request) }));
  const traffic = page.getByRole('img', { name: /^Requests over time/ });
  const providers = page.getByRole('img', { name: /^Requests by provider/ });
  const caller = page.getByRole('link', { name: /Test user/ });

  await page.goto('/analytics');

  // One stacked area per outcome. Each of the two buckets of provider bars is
  // a hover target and a segment per provider.
  await expect(traffic.locator('path')).toHaveCount(3);
  await expect(providers.locator('rect')).toHaveCount(6);

  // 160 requests against 100 in the window before.
  await expect(caller).toContainText('160');
  await expect(caller).toContainText('+60');
  await expect(caller).toContainText('↑ 60%');

  const trafficTabs = page.getByRole('button', { name: 'Tokens', exact: true }).locator('..');
  await trafficTabs.getByRole('button', { name: 'Error rate', exact: true }).click();

  // Monday failed none of 80 and Tuesday 10 of 120, which is 8.33%. The axis
  // tops out just above that.
  const errors = page.getByRole('img', { name: /^Error rate over time/ });
  await expect(errors.locator('circle')).toHaveCount(2);
  await expect(errors.getByText('8.5%', { exact: true })).toBeVisible();
});

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

// One user's session of seven requests, which ran for 4m 12s.
const CHECKOUT = {
  session_id: 'checkout-42',
  user_id: 'ada',
  users: 1,
  requests: 7,
  tokens: 4200,
  cost_total: 2.5,
  seconds: 252,
};

/**
 * Lists no sessions, and answers for the checkout session only when it is asked
 * for by id.
 */
function sessionsFor(request: RecordedApiRequest): SessionsResponse {
  const body = request.body as { session_id?: string };

  return body.session_id === CHECKOUT.session_id ? { count: 1, top: [CHECKOUT] } : { count: 0, top: [] };
}

test('a session that is not listed can be opened by id', async ({ page, api }) => {
  api.post(SESSIONS, (request) => ({ json: sessionsFor(request) }));
  const lookup = page.getByRole('navigation', { name: 'Sessions' }).getByLabel('Find a session by id');
  const main = page.getByRole('main');

  await page.goto('/analytics/sessions');
  await lookup.fill('checkout-42');
  await lookup.press('Enter');

  await expect(page).toHaveURL('/analytics/sessions?session=checkout-42');
  await expect
    .poll(() => api.matching('POST', SESSION_POSITIONS).at(-1)?.body)
    .toMatchObject({ session_id: 'checkout-42' });

  // The pane shows that session's own figures, such as how long it ran and
  // who ran it.
  await expect(main.getByText('4m 12s', { exact: true })).toBeVisible();
  await expect(main.getByText('ada', { exact: true })).toBeVisible();
});

test('sessions are summed up by their typical cost, their bands and how cost grows along them', async ({
  page,
  api,
}) => {
  // p1 to p99 in cents, so the median session cost 50 cents and the p95 95.
  const cents = Array.from({ length: 99 }, (_, index) => (index + 1) / 100);
  api.post(SESSION_DISTRIBUTION, {
    json: {
      sessions: 100,
      cost_percentiles: cents,
      request_percentiles: cents.map((value) => value * 100),
      seconds_percentiles: cents.map((value) => value * 500),
      cost_bands: [
        { min: 0, max: 1, sessions: 95, cost_total: 30 },
        { min: 1, max: null, sessions: 5, cost_total: 70 },
      ],
      request_bands: [
        { min: 1, max: 1, sessions: 40 },
        { min: 2, max: null, sessions: 60 },
      ],
    },
  });
  api.post(SESSION_POSITIONS, {
    json: {
      positions: [
        { position: 1, requests: 100, sessions: 100, cost_total: 10, input_tokens: 10_000 },
        { position: 20, requests: 10, sessions: 10, cost_total: 4.5, input_tokens: 90_000 },
      ],
    },
  });
  const main = page.getByRole('main');

  await page.goto('/analytics/sessions');

  await expect(main.getByText('$0.5000', { exact: true })).toBeVisible();
  await expect(main.getByText('4m 10s', { exact: true })).toBeVisible();
  await expect(main.getByText('< $1', { exact: true })).toBeVisible();
  await expect(main.getByText('$1+', { exact: true })).toBeVisible();
  await expect(main.getByText('The 5% of sessions over $1 are 70% of spend.')).toBeVisible();

  // 45 cents a request at the twentieth, against 10 cents at the first.
  await expect(main.getByText('The 20th request of a session costs 4.5× the first, on average.')).toBeVisible();
});
