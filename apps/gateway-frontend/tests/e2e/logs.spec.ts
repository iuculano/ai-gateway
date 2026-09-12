import { expect, test } from './api-mock';
import { FAILED_LOG, IDS, LOG_META, registerEmptyApp, SUCCESS_LOG, TRACE_IDS } from './fixtures';

test('auto-refresh updates counts and continues after a stats failure', async ({ page, api }) => {
  await page.clock.install();
  registerEmptyApp(api);
  let count = 1;
  let failStats = false;
  api.get('/api/logs', () => ({
    json: { data: [{ ...SUCCESS_LOG, model: `refreshed-model-${count}` }], meta: LOG_META },
  }));
  api.get('/api/logs/stats', () =>
    failStats
      ? { status: 503, json: { error: { message: 'Counts unavailable' } } }
      : {
          json: {
            total: count,
            estimated: false,
            by_status: { complete: count, failed: 0, incomplete: 0 },
            tokens: { input: 0, output: 0, total: 0 },
            cost: { input: 0, output: 0, total: 0 },
          },
        },
  );

  await page.goto('/logs');
  const counts = page.getByText(/matching logs/);
  await expect(counts).toContainText('1 success');
  const toggle = page.getByRole('switch', { name: 'Auto-refresh' });
  await toggle.click();

  count = 2;
  await page.clock.fastForward(10_000);
  await expect(page.getByText('refreshed-model-2', { exact: true })).toBeVisible();
  await expect(counts).toContainText('2 success');

  count = 3;
  failStats = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByText('refreshed-model-3', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry counts' })).toBeVisible();
  await expect(toggle).toBeChecked();

  count = 4;
  failStats = false;
  await page.clock.fastForward(10_000);
  await expect(page.getByText('refreshed-model-4', { exact: true })).toBeVisible();
  await expect(counts).toContainText('4 success');
  await expect(page.getByRole('button', { name: 'Retry counts' })).toBeHidden();
});

test('a stored request can be inspected and replayed in the playground', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/logs', (request) => {
    const status = new URLSearchParams(request.search).get('status');
    return {
      json: { data: [SUCCESS_LOG, FAILED_LOG].filter((log) => !status || log.status === status), meta: LOG_META },
    };
  });
  api.get(`/api/logs/${IDS.successLog}/request`, {
    json: {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Investigate this production incident.' }],
      temperature: 0.2,
      top_p: 0.8,
      max_completion_tokens: 64,
    },
  });
  api.get(`/api/logs/${IDS.successLog}/response`, {
    json: {
      model: 'gpt-5-2026-08-01',
      choices: [
        {
          message: { role: 'assistant', content: 'Recovered answer.', refusal: null },
          finish_reason: 'stop',
        },
      ],
    },
  });

  await page.goto('/logs');
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();

  // A correlated request shows its trace and links back to the run; an
  // uncorrelated one says so rather than linking nowhere.
  const trace = page.getByRole('link', { name: `Open trace ${TRACE_IDS.workflow}` }).first();
  await expect(trace).toHaveAttribute('href', `/traces?trace=${TRACE_IDS.workflow}`);
  await expect(trace).toHaveText(TRACE_IDS.workflow.slice(0, 8));

  await page.getByRole('button', { name: 'Failed', exact: true }).click();
  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'All', exact: true }).click();

  await page.getByText(SUCCESS_LOG.model, { exact: true }).click();
  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Finish reason', { exact: false })).toBeVisible();

  await page.locator(`a[href="/playground?from=${IDS.successLog}"]`).click();
  await expect(page).toHaveURL(`/playground?from=${IDS.successLog}`);
  await expect(page.getByPlaceholder('What do you want to ask?')).toHaveValue('Investigate this production incident.');
  await expect(page.locator('#playground-model-0')).toHaveValue('gpt-5');
  await expect(page.getByText('Loaded the request from that log')).toBeVisible();
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue('0.2');
  await expect(page.getByLabel('Top P', { exact: true })).toHaveValue('0.8');
  await expect(page.getByLabel('Max completion tokens', { exact: true })).toHaveValue('64');
  api.post('/api/chat/completions', {
    body: 'data: [DONE]\n\n',
    headers: { 'content-type': 'text/event-stream' },
  });
  await page.getByPlaceholder('Provider API key').fill('test-provider-key');
  const response = page.waitForResponse('**/api/chat/completions');
  await page.getByRole('button', { name: /^Run/ }).click();
  await response;
  expect(api.matching('POST', '/api/chat/completions')[0]?.body).toMatchObject({
    temperature: 0.2,
    top_p: 0.8,
    max_completion_tokens: 64,
  });
});

for (const scenario of [
  { failed: ['request'], omitted: [] },
  { failed: ['response'], omitted: [] },
  { failed: ['request', 'response'], omitted: [] },
  { failed: ['request'], omitted: ['response'] },
  { failed: ['response'], omitted: ['request'] },
]) {
  test(`payload retry: failed ${scenario.failed.join(', ')}, omitted ${scenario.omitted.join(', ') || 'none'}`, async ({
    page,
    api,
  }) => {
    registerEmptyApp(api);
    api.get('/api/logs', {
      json: {
        data: [
          {
            ...SUCCESS_LOG,
            has_request: !scenario.omitted.includes('request'),
            has_response: !scenario.omitted.includes('response'),
          },
        ],
        meta: LOG_META,
      },
    });
    const texts = { request: 'Stored request text', response: 'Stored response text' };
    const attempts = { request: 0, response: 0 };
    for (const kind of ['request', 'response'] as const) {
      if (scenario.omitted.includes(kind)) continue;
      api.get(`/api/logs/${IDS.successLog}/${kind}`, () => {
        attempts[kind]++;
        if (scenario.failed.includes(kind) && attempts[kind] === 1) {
          return { status: 503, json: { error: { message: `${kind} temporarily unavailable` } } };
        }
        return {
          json:
            kind === 'request'
              ? { messages: [{ role: 'user', content: texts.request }] }
              : { choices: [{ message: { role: 'assistant', content: texts.response }, finish_reason: 'stop' }] },
        };
      });
    }

    await page.goto('/logs');
    // Scope to the toggle: expanded details repeat the model name, and the trace link is a separate target.
    const row = page
      .getByRole('button', { name: new RegExp(SUCCESS_LOG.model) })
      .getByText(SUCCESS_LOG.model, { exact: true });
    await row.click();
    for (const kind of ['request', 'response'] as const) {
      if (scenario.omitted.includes(kind)) {
        await expect(page.getByText(`No ${kind} payload was stored.`, { exact: true })).toBeVisible();
      } else if (scenario.failed.includes(kind)) {
        await expect(page.getByText(`${kind} temporarily unavailable`, { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText(texts[kind], { exact: true })).toBeVisible();
      }
    }
    await row.click();
    await row.click();
    // Detect an unintended reactive retry loop while the failed panel is open.
    await page.waitForTimeout(500);
    for (const kind of ['request', 'response'] as const) {
      expect(attempts[kind]).toBe(scenario.omitted.includes(kind) ? 0 : 1);
    }

    for (const kind of scenario.failed) {
      await page.getByRole('button', { name: `Retry ${kind}`, exact: true }).click();
      await expect(page.getByText(texts[kind as keyof typeof texts], { exact: true })).toBeVisible();
    }
    for (const kind of ['request', 'response'] as const) {
      expect(attempts[kind]).toBe(scenario.omitted.includes(kind) ? 0 : scenario.failed.includes(kind) ? 2 : 1);
    }
  });
}

test('log status filters reach the backend and reset pagination', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/logs', (request) => {
    const query = new URLSearchParams(request.search);
    return {
      json: {
        data: [{ ...SUCCESS_LOG, status: query.get('status') ?? 'complete' }],
        meta: { ...LOG_META, oldest_id: IDS.successLog, more_data: !query.has('after_id') },
      },
    };
  });
  await page.goto('/logs');
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  for (const [label, status] of [
    ['Incomplete', 'incomplete'],
    ['Failed', 'failed'],
    ['Success', 'complete'],
    ['All', null],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect
      .poll(() => {
        const query = new URLSearchParams(api.matching('GET', '/api/logs').at(-1)?.search);
        return { status: query.get('status'), cursor: query.get('after_id') };
      })
      .toEqual({ status, cursor: null });
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  }
});
