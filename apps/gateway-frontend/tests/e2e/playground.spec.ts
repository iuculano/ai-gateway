import type { Page } from '@playwright/test';
import { expect, test } from './api-mock';
import { EMPTY_COMPLETION_STREAM, IDS, TRACE_IDS } from './fixtures';

const COMPLETIONS = '/api/chat/completions';
const DECISIONS = '/api/decisions';
const LOG_REQUEST = `/api/logs/${IDS.successLog}/request`;

const SPAM_QUESTION = { type: 'predicate', name: 'spam', instructions: 'Is this message spam?' };

// One value on the wrong side of each rule a numeric parameter has to pass.
const INVALID_PARAMETERS = [
  { label: 'Temperature', value: '-0.1', message: 'Temperature must be between 0 and 2.' },
  { label: 'Temperature', value: '2.1', message: 'Temperature must be between 0 and 2.' },
  { label: 'Top P', value: '-0.1', message: 'Top P must be between 0 and 1.' },
  { label: 'Top P', value: '1.1', message: 'Top P must be between 0 and 1.' },
  { label: 'Max completion tokens', value: '0', message: 'Max completion tokens must be a positive safe integer.' },
  { label: 'Max completion tokens', value: '1.5', message: 'Max completion tokens must be a positive safe integer.' },
  {
    label: 'Max completion tokens',
    value: '9007199254740992',
    message: 'Max completion tokens must be a positive safe integer.',
  },
];

/**
 * Fills in what a chat request needs before it can be sent, for every model
 * column.
 */
async function writeRequest(page: Page, prompt: string): Promise<void> {
  await page.getByPlaceholder('What do you want to ask?').fill(prompt);

  for (const key of await page.getByPlaceholder('Provider API key').all()) {
    await key.fill('test-provider-key');
  }
}

/**
 * Sends the request and waits for the gateway to answer it.
 */
async function run(page: Page): Promise<void> {
  const response = page.waitForResponse(`**${COMPLETIONS}`);
  await page.getByRole('button', { name: /^Run/ }).click();

  await response;
}

/**
 * Replaces the page's fetch so that completions stay open until they are
 * aborted, and records whether each one was. Runs in the browser, so it can use
 * nothing from this file.
 */
function holdCompletionsOpen(): void {
  const requests: { aborted: boolean }[] = [];
  const originalFetch = window.fetch.bind(window);

  Object.assign(window, {
    heldCompletions: requests,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) !== '/api/chat/completions') {
        return originalFetch(input, init);
      }

      const request = { aborted: false };
      requests.push(request);

      const signal = init?.signal;
      const streaming = JSON.parse(String(init?.body)).stream;

      // A whole response that never arrives.
      if (!streaming) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            request.aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }

      // A stream that delivers its first words and then stays open, because
      // an abort after the headers have arrived is a different path from one
      // before them.
      const chunk = { choices: [{ index: 0, delta: { content: 'Partial answer' }, finish_reason: null }] };
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));

          signal?.addEventListener('abort', () => {
            request.aborted = true;
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });

      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
}

function heldCompletions(page: Page): Promise<{ aborted: boolean }[]> {
  return page.evaluate(() => (window as unknown as { heldCompletions: { aborted: boolean }[] }).heldCompletions);
}

/**
 * Starts a two-model comparison whose requests stay open, and waits until both
 * are in flight.
 */
async function startHeldComparison(page: Page, streaming: boolean): Promise<void> {
  await page.addInitScript(holdCompletionsOpen);
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await page.locator('#playground-model-1').fill('openai/gpt-5-mini');
  await writeRequest(page, 'Hello');

  if (!streaming) {
    await page.getByRole('switch', { name: /Stream/ }).click();
  }

  await page.getByRole('button', { name: /^Run/ }).click();

  await expect.poll(() => heldCompletions(page)).toEqual([{ aborted: false }, { aborted: false }]);
}

// Sending a chat request

test('a streamed completion is shown as it arrives, with its usage and trace', async ({ page, api }) => {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: ' from Relay' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } },
  ];
  const stream = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  api.post(COMPLETIONS, {
    body: `${stream}data: [DONE]\n\n`,
    headers: { 'content-type': 'text/event-stream', 'ai-trace-id': TRACE_IDS.workflow },
  });

  await page.goto('/playground');
  await writeRequest(page, 'Say hello from the gateway.');
  await run(page);

  await expect(page.getByText('Hello from Relay', { exact: true })).toBeVisible();
  await expect(page.getByText('9 tok', { exact: true })).toBeVisible();
  await expect(page.getByText(TRACE_IDS.workflow, { exact: true })).toBeVisible();
});

test('the request carries the provider key as a header and asks for a stream with usage', async ({ page, api }) => {
  api.post(COMPLETIONS, EMPTY_COMPLETION_STREAM);
  const caching = page.getByRole('switch', { name: 'Enable caching', exact: true });

  await page.goto('/playground');
  await writeRequest(page, 'Say hello from the gateway.');
  await expect(caching).not.toBeChecked();
  await caching.click();
  await run(page);

  const [call] = api.matching('POST', COMPLETIONS);
  expect(call?.headers['ai-api-key']).toBe('test-provider-key');
  expect(call?.headers['ai-cache-enabled']).toBe('true');
  expect(call?.body).toMatchObject({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Say hello from the gateway.' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});

// Numeric parameters

test('numeric parameters are sent as typed, including zero, and left out once cleared', async ({ page, api }) => {
  api.post(COMPLETIONS, EMPTY_COMPLETION_STREAM);
  const temperature = page.getByLabel('Temperature', { exact: true });
  const topP = page.getByLabel('Top P', { exact: true });
  const maxTokens = page.getByLabel('Max completion tokens', { exact: true });
  await page.goto('/playground');
  await writeRequest(page, 'Hello');

  // Both ends of each range. A zero has to be sent rather than read as unset.
  const boundaries = [
    { temperature: 0, top_p: 0, max_completion_tokens: 1 },
    { temperature: 2, top_p: 1, max_completion_tokens: 256 },
  ];

  for (const values of boundaries) {
    await temperature.fill(String(values.temperature));
    await topP.fill(String(values.top_p));
    await maxTokens.fill(String(values.max_completion_tokens));
    await run(page);

    expect(api.matching('POST', COMPLETIONS).at(-1)?.body).toMatchObject(values);
  }

  await temperature.fill('');
  await topP.fill('');
  await maxTokens.fill('');
  await run(page);

  const cleared = api.matching('POST', COMPLETIONS).at(-1)?.body;
  expect(cleared).not.toHaveProperty('temperature');
  expect(cleared).not.toHaveProperty('top_p');
  expect(cleared).not.toHaveProperty('max_completion_tokens');
});

for (const invalid of INVALID_PARAMETERS) {
  test(`${invalid.label} of ${invalid.value} is refused without sending`, async ({ page, api }) => {
    await page.goto('/playground');
    await writeRequest(page, 'Hello');
    await page.getByLabel(invalid.label, { exact: true }).fill(invalid.value);

    await page.getByRole('button', { name: /^Run/ }).click();

    await expect(page.getByText(invalid.message, { exact: true })).toBeVisible();
    expect(api.matching('POST', COMPLETIONS)).toHaveLength(0);
  });
}

// Comparing models

test('models can be added up to four and removed down to one, each keeping its own key', async ({ page }) => {
  const keys = page.getByPlaceholder('Provider API key');
  const add = page.getByRole('button', { name: 'Add model', exact: true });
  const remove = page.getByRole('button', { name: 'Remove this model', exact: true });
  await page.goto('/playground');
  await expect(keys).toHaveCount(1);

  // Removing the first column must leave the second one's key where it was
  // typed.
  await add.click();
  await keys.nth(1).fill('keep-this-credential');
  await remove.first().click();

  await expect(keys).toHaveCount(1);
  await expect(keys).toHaveValue('keep-this-credential');
  await expect(remove).toBeDisabled();

  await add.click();
  await add.click();
  await add.click();

  await expect(keys).toHaveCount(4);
  await expect(add).toBeHidden();
});

test('a running comparison locks the form and cannot be started twice', async ({ page }) => {
  await startHeldComparison(page, true);

  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Run/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add model', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();

  await page.keyboard.press('Control+Enter');

  expect(await heldCompletions(page)).toHaveLength(2);
});

for (const streaming of [true, false]) {
  const kind = streaming ? 'streaming' : 'unstreamed';

  test(`Stop aborts every ${kind} request`, async ({ page }) => {
    await startHeldComparison(page, streaming);

    await page.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();
    await expect.poll(() => heldCompletions(page)).toEqual([{ aborted: true }, { aborted: true }]);
  });

  test(`leaving the page aborts every ${kind} request`, async ({ page }) => {
    await startHeldComparison(page, streaming);

    // A client-side navigation keeps the window, so only the page's own
    // teardown can abort these.
    await page.getByRole('link', { name: 'API Keys', exact: true }).click();

    await expect(page).toHaveURL('/keys');
    await expect.poll(() => heldCompletions(page)).toEqual([{ aborted: true }, { aborted: true }]);
  });
}

test('stopping a stream keeps the words that had already arrived', async ({ page }) => {
  await startHeldComparison(page, true);
  await expect(page.getByText('Partial answer', { exact: true })).toHaveCount(2);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();
  await expect(page.getByText('Partial answer', { exact: true })).toHaveCount(2);
});

// Replaying a log

test('a request replayed from a log arrives with its prompt, model and parameters', async ({ page, api }) => {
  const parameters = { temperature: 0.2, top_p: 0.8, max_completion_tokens: 64 };
  api.post(COMPLETIONS, EMPTY_COMPLETION_STREAM);
  api.get(LOG_REQUEST, {
    json: {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Investigate this production incident.' }],
      ...parameters,
    },
  });

  await page.goto(`/playground?from=${IDS.successLog}`);

  await expect(page.getByText('Loaded the request from that log')).toBeVisible();
  await expect(page.getByPlaceholder('What do you want to ask?')).toHaveValue('Investigate this production incident.');
  await expect(page.locator('#playground-model-0')).toHaveValue('gpt-5');

  // The parameters have to survive into the request, not only into the form.
  await page.getByPlaceholder('Provider API key').fill('test-provider-key');
  await run(page);

  expect(api.matching('POST', COMPLETIONS)[0]?.body).toMatchObject(parameters);
});

test('a decision replayed from a log arrives with its input, question and model', async ({ page, api }) => {
  api.get(LOG_REQUEST, {
    json: { model: 'openai/gpt-6-luna', input: 'Win a free cruise!', questions: [SPAM_QUESTION] },
  });

  await page.goto(`/playground/decisions?from=${IDS.successLog}`);

  await expect(page.getByText('Loaded the request from that log')).toBeVisible();
  await expect(page.getByLabel('Input', { exact: true })).toHaveValue('Win a free cruise!');
  await expect(page.getByLabel('Question name')).toHaveValue(SPAM_QUESTION.name);
  await expect(page.getByLabel('Question instructions')).toHaveValue(SPAM_QUESTION.instructions);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('openai/gpt-6-luna');
});

// Decisions

test('the decisions tab sends typed questions and renders the answers', async ({ page, api }) => {
  api.post(DECISIONS, {
    json: {
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'spam', probability: 0.03 }],
      usage: { input_tokens: 60, output_tokens: 12, total_tokens: 72 },
    },
  });

  await page.goto('/playground');
  await page.getByRole('button', { name: 'Decisions', exact: true }).click();
  await expect(page).toHaveURL(/\/playground\/decisions$/);

  await page.getByLabel('Input', { exact: true }).fill('Win a free cruise!');
  await page.getByLabel('Question name').fill(SPAM_QUESTION.name);
  await page.getByLabel('Question instructions').fill(SPAM_QUESTION.instructions);
  await page.getByLabel('Model', { exact: true }).fill('openai/gpt-6-luna');
  await page.getByPlaceholder('Provider API key').fill('test-provider-key');
  await page.getByRole('button', { name: /^Run/ }).click();

  await expect(page.getByText('· 3% true', { exact: true })).toBeVisible();
  await expect(page.getByText('72 tok', { exact: true })).toBeVisible();

  const [call] = api.matching('POST', DECISIONS);
  expect(call?.headers['ai-api-key']).toBe('test-provider-key');
  expect(call?.body).toEqual({
    model: 'openai/gpt-6-luna',
    input: 'Win a free cruise!',
    questions: [SPAM_QUESTION],
  });
});

test('two questions with the same name are refused without sending', async ({ page, api }) => {
  // Answers come back keyed by name, so a duplicate could not be told apart.
  await page.goto('/playground/decisions');
  await page.getByLabel('Input', { exact: true }).fill('Win a free cruise!');
  await page.getByRole('button', { name: 'Add question' }).click();

  for (const index of [0, 1]) {
    await page.getByLabel('Question name').nth(index).fill(SPAM_QUESTION.name);
    await page.getByLabel('Question instructions').nth(index).fill(SPAM_QUESTION.instructions);
  }

  await page.getByLabel('Model', { exact: true }).fill('openai/gpt-6-luna');
  await page.getByPlaceholder('Provider API key').fill('test-provider-key');
  await page.getByRole('button', { name: /^Run/ }).click();

  await expect(page.getByText('Two questions are named spam.', { exact: true })).toBeVisible();
  expect(api.matching('POST', DECISIONS)).toHaveLength(0);
});
