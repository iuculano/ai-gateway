import { expect, test } from './api-mock';
import { FAILED_LOG, IDS, LOG_META, registerEmptyApp, SUCCESS_LOG } from './fixtures';

test('a stored request can be inspected and replayed in the playground', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/logs', { json: { data: [SUCCESS_LOG, FAILED_LOG], meta: LOG_META } });
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

  await page.getByRole('button', { name: 'Errors' }).click();
  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'All', exact: true }).click();

  await page.getByText(SUCCESS_LOG.model, { exact: true }).click();
  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('gpt-5-2026-08-01', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Replay in playground' }).click();
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
  await page.getByRole('button', { name: 'Remove this model', exact: true }).last().click();
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
    const row = page.getByRole('button', { name: new RegExp(SUCCESS_LOG.model) });
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
