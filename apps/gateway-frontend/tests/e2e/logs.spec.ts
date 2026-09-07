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
