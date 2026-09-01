import { expect, test } from './api-mock';
import { IDS, registerEmptyApp } from './fixtures';

test('the playground streams a completion and sends the intended request', async ({ page, api }) => {
  registerEmptyApp(api);

  const frames = [
    {
      id: 'chatcmpl-playwright',
      object: 'chat.completion.chunk',
      created: 1_787_529_600,
      model: 'gpt-5',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, logprobs: null, finish_reason: null }],
      usage: null,
    },
    {
      id: 'chatcmpl-playwright',
      object: 'chat.completion.chunk',
      created: 1_787_529_600,
      model: 'gpt-5',
      choices: [{ index: 0, delta: { content: ' from Relay' }, logprobs: null, finish_reason: 'stop' }],
      usage: null,
    },
    {
      id: 'chatcmpl-playwright',
      object: 'chat.completion.chunk',
      created: 1_787_529_600,
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
    },
  ];
  const sse = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;

  api.post('/api/chat/completions', {
    body: sse,
    headers: {
      'content-type': 'text/event-stream',
      'ai-log-id': IDS.successLog,
    },
  });

  await page.goto('/playground');
  await page.getByPlaceholder('What do you want to ask?').fill('Say hello from the gateway.');
  await page.getByPlaceholder('Provider API key').fill('provider-secret-for-test');
  await page.getByRole('button', { name: /^Run/ }).click();

  await expect(page.getByText('Hello from Relay', { exact: true })).toBeVisible();
  await expect(page.getByText('9', { exact: true })).toBeVisible();
  await expect(page.getByText(IDS.successLog, { exact: true })).toBeVisible();

  const calls = api.matching('POST', '/api/chat/completions');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers['ai-api-key']).toBe('provider-secret-for-test');
  expect(calls[0]?.body).toMatchObject({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Say hello from the gateway.' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});
