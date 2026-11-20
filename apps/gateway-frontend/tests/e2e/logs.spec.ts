import { expect, test } from './api-mock';
import { FAILED_LOG, IDS, LOG_META, SUCCESS_LOG, TRACE_IDS } from './fixtures';

const LOGS = '/api/logs';
const LOG_REQUEST = `/api/logs/${IDS.successLog}/request`;
const LOG_RESPONSE = `/api/logs/${IDS.successLog}/response`;

const STORED_REQUEST = { messages: [{ role: 'user', content: 'Investigate this production incident.' }] };
const STORED_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: 'Recovered answer.', refusal: null }, finish_reason: 'stop' }],
};

// The status each tab asks the backend for.
const STATUS_TABS = [
  { label: 'Incomplete', status: 'incomplete' },
  { label: 'Failed', status: 'failed' },
  { label: 'Success', status: 'complete' },
  { label: 'All', status: null },
];

// Auto-refresh

test('auto-refresh keeps updating the list through a failed count', async ({ page, api }) => {
  let refreshes = 1;
  let countsFail = false;
  api.get(LOGS, () => ({
    json: { data: [{ ...SUCCESS_LOG, model: `refreshed-model-${refreshes}` }], meta: LOG_META },
  }));
  api.get('/api/logs/count', () => {
    if (countsFail) {
      return { status: 503, json: { error: { message: 'Counts unavailable' } } };
    }

    return {
      json: { total: refreshes, estimated: false, by_status: { complete: refreshes, failed: 0, incomplete: 0 } },
    };
  });
  const counts = page.getByText(/matching logs/);
  const toggle = page.getByRole('switch', { name: 'Auto-refresh' });
  const retryCounts = page.getByRole('button', { name: 'Retry counts' });

  await page.clock.install();
  await page.goto('/logs');
  await expect(counts).toContainText('1 success');
  await toggle.click();

  refreshes = 2;
  await page.clock.fastForward(10_000);

  await expect(page.getByText('refreshed-model-2', { exact: true })).toBeVisible();
  await expect(counts).toContainText('2 success');

  // The counts failing must not stop the list, or switch auto-refresh off.
  refreshes = 3;
  countsFail = true;
  await page.clock.fastForward(10_000);

  await expect(page.getByText('refreshed-model-3', { exact: true })).toBeVisible();
  await expect(retryCounts).toBeVisible();
  await expect(toggle).toBeChecked();

  refreshes = 4;
  countsFail = false;
  await page.clock.fastForward(10_000);

  await expect(page.getByText('refreshed-model-4', { exact: true })).toBeVisible();
  await expect(counts).toContainText('4 success');
  await expect(retryCounts).toBeHidden();
});

// Links out of a row

test('a correlated log links back to its trace', async ({ page, api }) => {
  api.get(LOGS, { json: { data: [SUCCESS_LOG], meta: LOG_META } });

  await page.goto('/logs');

  const trace = page.getByRole('link', { name: `Open trace ${TRACE_IDS.workflow}` });
  await expect(trace).toHaveAttribute('href', `/traces?trace=${TRACE_IDS.workflow}`);
  await expect(trace).toHaveText(TRACE_IDS.workflow.slice(0, 8));
});

test('a log replays into the playground that can run it, when one can', async ({ page, api }) => {
  const decision = { ...SUCCESS_LOG, id: IDS.failedLog, operation: 'decision' };
  const embedding = { ...SUCCESS_LOG, id: IDS.model, operation: 'embedding' };
  api.get(LOGS, { json: { data: [SUCCESS_LOG, decision, embedding], meta: LOG_META } });

  await page.goto('/logs');

  // Three logs, two links. There is no playground to replay an embedding into.
  const replays = page.getByRole('link', { name: 'Replay in Playground' });
  await expect(replays).toHaveCount(2);
  await expect(replays.nth(0)).toHaveAttribute('href', `/playground?from=${IDS.successLog}`);
  await expect(replays.nth(1)).toHaveAttribute('href', `/playground/decisions?from=${IDS.failedLog}`);
});

// Stored payloads

test('an expanded log shows its stored request and response', async ({ page, api }) => {
  api.get(LOGS, { json: { data: [SUCCESS_LOG], meta: LOG_META } });
  api.get(LOG_REQUEST, { json: STORED_REQUEST });
  api.get(LOG_RESPONSE, { json: STORED_RESPONSE });

  await page.goto('/logs');
  await page.getByText(SUCCESS_LOG.model, { exact: true }).click();

  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered answer.', { exact: true })).toBeVisible();
});

test('a payload that failed to load is retried alone, and only when asked', async ({ page, api }) => {
  let requestAttempts = 0;
  api.get(LOGS, { json: { data: [SUCCESS_LOG], meta: LOG_META } });
  api.get(LOG_RESPONSE, { json: STORED_RESPONSE });
  api.get(LOG_REQUEST, () => {
    requestAttempts += 1;

    if (requestAttempts === 1) {
      return { status: 503, json: { error: { message: 'request temporarily unavailable' } } };
    }

    return { json: STORED_REQUEST };
  });

  // Scoped to the row's own toggle, because the expanded details repeat the
  // model name.
  const row = page.getByRole('button', { name: new RegExp(SUCCESS_LOG.model) }).getByText(SUCCESS_LOG.model);

  await page.goto('/logs');
  await row.click();

  await expect(page.getByText('request temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered answer.', { exact: true })).toBeVisible();

  // Closing and reopening the row is not a retry.
  await row.click();
  await row.click();
  await api.settle();
  expect(requestAttempts).toBe(1);

  await page.getByRole('button', { name: 'Retry request', exact: true }).click();

  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  expect(requestAttempts).toBe(2);
  expect(api.matching('GET', LOG_RESPONSE)).toHaveLength(1);
});

test('a log stored without a response says so and never asks for one', async ({ page, api }) => {
  api.get(LOGS, { json: { data: [{ ...SUCCESS_LOG, has_response: false }], meta: LOG_META } });
  api.get(LOG_REQUEST, { json: STORED_REQUEST });

  await page.goto('/logs');
  await page.getByText(SUCCESS_LOG.model, { exact: true }).click();

  await expect(page.getByText('No response payload was stored.', { exact: true })).toBeVisible();
  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  expect(api.matching('GET', LOG_RESPONSE)).toHaveLength(0);
});

// Filtering and paging

test('the status tabs filter the list', async ({ page, api }) => {
  api.get(LOGS, (request) => {
    const status = request.query.get('status');
    const logs = [SUCCESS_LOG, FAILED_LOG].filter((log) => !status || log.status === status);

    return { json: { data: logs, meta: LOG_META } };
  });

  await page.goto('/logs');
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Failed', exact: true }).click();

  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeHidden();
});

test('changing the status filter starts again from the first page', async ({ page, api }) => {
  api.get(LOGS, (request) => {
    const more = !request.query.has('after_id');

    return { json: { data: [SUCCESS_LOG], meta: { ...LOG_META, oldest_id: IDS.successLog, more_data: more } } };
  });
  await page.goto('/logs');

  for (const { label, status } of STATUS_TABS) {
    await page.getByRole('button', { name: 'Older', exact: true }).click();
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: label, exact: true }).click();

    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    expect(api.matching('GET', LOGS).at(-1)?.query.get('status')).toBe(status);
    expect(api.matching('GET', LOGS).at(-1)?.query.has('after_id')).toBe(false);
  }
});
