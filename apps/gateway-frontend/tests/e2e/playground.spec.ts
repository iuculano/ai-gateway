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
  const caching = page.getByRole('switch', { name: 'Enable caching', exact: true });
  await expect(caching).not.toBeChecked();
  await caching.click();
  await page.getByPlaceholder('Provider API key').fill('provider-secret-for-test');
  await page.getByRole('button', { name: /^Run/ }).click();

  await expect(page.getByText('Hello from Relay', { exact: true })).toBeVisible();
  await expect(page.getByText('9 tok', { exact: true })).toBeVisible();
  await expect(page.getByText(IDS.successLog, { exact: true })).toBeVisible();

  const calls = api.matching('POST', '/api/chat/completions');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers['ai-api-key']).toBe('provider-secret-for-test');
  expect(calls[0]?.headers['ai-cache-enabled']).toBe('true');
  expect(calls[0]?.body).toMatchObject({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Say hello from the gateway.' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('numeric parameters send edited values and are omitted after clearing', async ({ page, api }) => {
  registerEmptyApp(api);
  api.post('/api/chat/completions', {
    body: 'data: [DONE]\n\n',
    headers: { 'content-type': 'text/event-stream' },
  });

  await page.goto('/playground');
  await page.getByPlaceholder('What do you want to ask?').fill('Hello');
  await page.getByPlaceholder('Provider API key').fill('test-provider-key');

  const temperature = page.getByLabel('Temperature', { exact: true });
  const topP = page.getByLabel('Top P', { exact: true });
  const maxTokens = page.getByLabel('Max completion tokens', { exact: true });
  const run = page.getByRole('button', { name: /^Run/ });

  // Include both boundaries and a fractional value; zero must not become unset.
  for (const values of [
    { temperature: 0.7, top_p: 0.9, max_completion_tokens: 128 },
    { temperature: 0, top_p: 0, max_completion_tokens: 1 },
    { temperature: 2, top_p: 1, max_completion_tokens: 256 },
  ]) {
    await temperature.fill(String(values.temperature));
    await topP.fill(String(values.top_p));
    await maxTokens.fill(String(values.max_completion_tokens));
    const response = page.waitForResponse('**/api/chat/completions');
    await run.click();
    await response;
    await expect(run).toBeVisible();
    expect(api.matching('POST', '/api/chat/completions').at(-1)?.body).toMatchObject(values);
  }

  await temperature.fill('');
  await topP.fill('');
  await maxTokens.fill('');
  const response = page.waitForResponse('**/api/chat/completions');
  await run.click();
  await response;
  await expect(run).toBeVisible();

  const calls = api.matching('POST', '/api/chat/completions');
  expect(calls).toHaveLength(4);
  for (const field of ['temperature', 'top_p', 'max_completion_tokens']) {
    expect(calls.at(-1)?.body).not.toHaveProperty(field);
  }
});

for (const invalid of [
  { label: 'Temperature', value: '-0.1', message: 'Temperature must be between 0 and 2.' },
  { label: 'Temperature', value: '2.1', message: 'Temperature must be between 0 and 2.' },
  { label: 'Top P', value: '-0.1', message: 'Top P must be between 0 and 1.' },
  { label: 'Top P', value: '1.1', message: 'Top P must be between 0 and 1.' },
  { label: 'Max completion tokens', value: '0', message: 'Max completion tokens must be a positive safe integer.' },
  { label: 'Max completion tokens', value: '-1', message: 'Max completion tokens must be a positive safe integer.' },
  { label: 'Max completion tokens', value: '1.5', message: 'Max completion tokens must be a positive safe integer.' },
  {
    label: 'Max completion tokens',
    value: '9007199254740992',
    message: 'Max completion tokens must be a positive safe integer.',
  },
]) {
  test(`invalid ${invalid.label} ${invalid.value} does not send a request`, async ({ page, api }) => {
    registerEmptyApp(api);
    await page.goto('/playground');
    await page.getByPlaceholder('What do you want to ask?').fill('Hello');
    await page.getByPlaceholder('Provider API key').fill('test-provider-key');
    await page.getByLabel(invalid.label, { exact: true }).fill(invalid.value);
    await page.getByRole('button', { name: /^Run/ }).click();
    await expect(page.getByText(invalid.message, { exact: true })).toBeVisible();
    expect(api.matching('POST', '/api/chat/completions')).toHaveLength(0);
  });
}

// Keep requests open in the browser so the test can observe the actual AbortSignal,
// including aborts after streaming has already delivered response headers and text.
for (const stream of [true, false]) {
  for (const count of [1, 2]) {
    for (const action of ['stop', 'navigate'] as const) {
      test(`${action} cancels ${count} comparison requests (${stream ? 'streaming' : 'whole response'})`, async ({
        page,
        api,
      }) => {
        registerEmptyApp(api);
        await page.addInitScript(() => {
          const requests: { aborted: boolean }[] = [];
          Object.assign(window, { playgroundRequests: requests });
          const originalFetch = window.fetch.bind(window);
          window.fetch = new Proxy(originalFetch, {
            async apply(_target, _thisArg, [input, init]: [RequestInfo | URL, RequestInit?]) {
              if (String(input) !== '/api/chat/completions') return originalFetch(input, init);
              const request = { aborted: false };
              requests.push(request);
              const signal = init?.signal;
              const abortError = () => new DOMException('Aborted', 'AbortError');
              const body = JSON.parse(String(init?.body));

              if (!body.stream) {
                return new Promise<Response>((_resolve, reject) => {
                  signal?.addEventListener(
                    'abort',
                    () => {
                      request.aborted = true;
                      reject(abortError());
                    },
                    { once: true },
                  );
                });
              }

              const responseBody = new ReadableStream<Uint8Array>({
                start(controller) {
                  const chunk = {
                    choices: [{ index: 0, delta: { content: 'Partial answer' }, finish_reason: null }],
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  signal?.addEventListener(
                    'abort',
                    () => {
                      request.aborted = true;
                      controller.error(abortError());
                    },
                    { once: true },
                  );
                },
              });
              return new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } });
            },
          });
        });

        const requests = () =>
          page.evaluate(
            () => (window as typeof window & { playgroundRequests: { aborted: boolean }[] }).playgroundRequests,
          );
        await page.goto('/playground');
        if (count === 2) {
          await page.getByRole('button', { name: 'Add model', exact: true }).click();
          await page.locator('#playground-model-1').fill('openai/gpt-5-mini');
        }
        await page.getByPlaceholder('What do you want to ask?').fill('Hello');
        for (const field of await page.getByPlaceholder('Provider API key').all()) {
          await field.fill('test-provider-key');
        }
        if (!stream) await page.getByRole('switch', { name: /Stream/ }).click();
        await page.getByRole('button', { name: /^Run/ }).click();
        await expect.poll(requests).toEqual(Array.from({ length: count }, () => ({ aborted: false })));
        if (stream) await expect(page.getByText('Partial answer', { exact: true })).toHaveCount(count);

        await expect(page.getByRole('button', { name: 'Add model', exact: true })).toBeDisabled();
        for (const button of await page.getByRole('button', { name: 'Remove this model', exact: true }).all()) {
          await expect(button).toBeDisabled();
        }
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Run/ })).toBeHidden();
        await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
        await page.keyboard.press('Control+Enter');
        expect(await requests()).toHaveLength(count);

        if (action === 'stop') {
          await page.getByRole('button', { name: 'Stop', exact: true }).click();
          await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();
          if (stream) await expect(page.getByText('Partial answer', { exact: true })).toHaveCount(count);
        } else {
          // Client navigation preserves the window, so aborts must come from page teardown.
          await page.getByRole('link', { name: 'API Keys', exact: true }).click();
          await expect(page).toHaveURL('/keys');
        }
        await expect.poll(requests).toEqual(Array.from({ length: count }, () => ({ aborted: true })));
      });
    }
  }
}

test('the playground has one comparison layout with one to four model columns', async ({ page, api }) => {
  registerEmptyApp(api);
  await page.goto('/playground');
  await expect(page.getByRole('button', { name: /^(Single|Compare)$/ })).toHaveCount(0);
  const keys = page.getByPlaceholder('Provider API key');
  const remove = page.getByRole('button', { name: 'Remove this model', exact: true });
  const add = page.getByRole('button', { name: 'Add model', exact: true });
  await expect(keys).toHaveCount(1);
  await add.click();
  await expect(keys).toHaveCount(2);
  await keys.nth(1).fill('keep-this-credential');
  await remove.first().click();
  await expect(keys).toHaveCount(1);
  await expect(keys).toHaveValue('keep-this-credential');
  await expect(remove).toBeDisabled();
  for (let count = 2; count <= 4; count++) {
    await add.click();
    await expect(keys).toHaveCount(count);
  }
  await expect(add).toBeHidden();
});
