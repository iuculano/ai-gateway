import { beforeEach, expect, mock, test } from 'bun:test';
import type {
  ChatCompletionBody,
  ChatCompletionChunk,
  ChatCompletionHeaders,
} from '../../src/api/chat-completions/chat-completions.schemas';
import { callerFixture, installModuleMocks, LOG_ID, logCapture, resetDoubles } from './doubles';

await installModuleMocks();

const providerModel = { provider: 'test', modelId: 'test-model' };

mock.module('@ai-sdk/openai', () => ({
  createOpenAI: () => ({ chat: () => providerModel }),
}));

mock.module('@ai-sdk/azure', () => ({
  createAzure: () => ({ chat: () => providerModel }),
}));

const responseMetadata = {
  id: 'chatcmpl-integration',
  timestamp: new Date('2026-01-02T03:04:05.000Z'),
  modelId: 'test-model',
};

const aiState = {
  generateCalls: [] as unknown[],
  streamCalls: [] as unknown[],
  generateError: null as unknown,
  streamResponseError: null as unknown,
  streamParts: [] as unknown[],
  generateResult: {} as Record<string, unknown>,

  reset() {
    aiState.generateCalls = [];
    aiState.streamCalls = [];
    aiState.generateError = null;
    aiState.streamResponseError = null;
    aiState.streamParts = [];
    aiState.generateResult = {
      response: responseMetadata,
      text: 'Hello from the provider',
      toolCalls: [],
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
        inputTokenDetails: { cacheReadTokens: 2 },
        outputTokenDetails: { reasoningTokens: 1 },
      },
    };
  },
};

const actualAi = await import('ai');
mock.module('ai', () => ({
  ...actualAi,

  async generateText(options: unknown) {
    aiState.generateCalls.push(options);
    if (aiState.generateError) {
      throw aiState.generateError;
    }

    return aiState.generateResult;
  },

  streamText(options: unknown) {
    aiState.streamCalls.push(options);

    return {
      response: aiState.streamResponseError
        ? Promise.reject(aiState.streamResponseError)
        : Promise.resolve(responseMetadata),
      fullStream: (async function* () {
        for (const part of aiState.streamParts) {
          yield part;
        }
      })(),
    };
  },
}));

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/chat-completions/chat-completions.services');

const redisModule = await import('@repo/redis');
const rateLimitState = {
  result: {
    limit: 2,
    isLimited: false,
    remainingQuota: 1,
    retryAfterSeconds: null as number | null,
    delaySeconds: null,
  },
};

mock.module('@repo/redis', () => ({
  ...redisModule,
  consumeFixedWindowCounter: async () => rateLimitState.result,
}));

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/chat-completions/chat-completions.handlers');

const httpCaller = {
  ...callerFixture,
  permissions: { scopes: ['chat-completions:write'] },
};
const app = new OpenAPIHono();
app.onError(errorHandler());
app.use('*', async (c, next) => {
  c.set('caller', httpCaller);
  // biome-ignore lint/suspicious/noExplicitAny: minimal request logger for handler tests
  c.set('logger', { error() {}, warn() {}, info() {}, debug() {} } as any);
  await next();
});
app.use('*', callerContext());
app.route('/v1', handlers);

function headers(overrides: Partial<ChatCompletionHeaders> = {}): ChatCompletionHeaders {
  return { 'ai-api-key': 'upstream-secret', ...overrides };
}

function body(overrides: Partial<ChatCompletionBody> = {}): ChatCompletionBody {
  return {
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

beforeEach(() => {
  resetDoubles();
  aiState.reset();
  // This suite watches the log lifecycle rather than running it. Every other
  // suite leaves passthrough on and gets the real module.
  logCapture.passthrough = false;
  rateLimitState.result = {
    limit: 2,
    isLimited: false,
    remainingQuota: 1,
    retryAfterSeconds: null,
    delaySeconds: null,
  };
});

test('a non-streaming completion maps provider output and closes its inference log', async () => {
  let echoedLogId: string | undefined;

  const completion = await runWithCaller(callerFixture, () =>
    Services.createChatCompletion(
      headers({ 'ai-max-retries': 0 }),
      body({ temperature: 0, top_p: 0, seed: 0, stop: 'END' }),
      (id) => {
        echoedLogId = id;
      },
    ),
  );

  expect(echoedLogId).toBe(LOG_ID);
  expect(completion).toMatchObject({
    id: responseMetadata.id,
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        message: { role: 'assistant', content: 'Hello from the provider' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 4,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  });

  expect(aiState.generateCalls[0]).toMatchObject({
    temperature: 0,
    topP: 0,
    seed: 0,
    stopSequences: ['END'],
    maxRetries: 0,
  });
  expect(logCapture.started).toEqual([
    {
      organizationId: callerFixture.organization.id,
      entry: { model: 'test-model', provider: 'openai' },
    },
  ]);
  expect(logCapture.completed[0]).toMatchObject({
    organizationId: callerFixture.organization.id,
    id: LOG_ID,
    entry: {
      input_tokens: 7,
      output_tokens: 4,
      request: { model: 'openai/test-model' },
      response: { id: responseMetadata.id },
    },
  });
  expect(logCapture.failed).toHaveLength(0);
});

test('a provider timeout becomes a 504 and marks the open log failed', async () => {
  aiState.generateError = Object.assign(new Error('provider timed out'), { name: 'TimeoutError' });

  await expect(
    runWithCaller(callerFixture, () => Services.createChatCompletion(headers(), body())),
  ).rejects.toMatchObject({ status: 504 });

  expect(logCapture.completed).toHaveLength(0);
  expect(logCapture.failed[0]).toMatchObject({
    organizationId: callerFixture.organization.id,
    id: LOG_ID,
    entry: { request: { model: 'openai/test-model' } },
  });
});

test('an unsupported response format is rejected before provider or logging work starts', async () => {
  await expect(
    runWithCaller(callerFixture, () =>
      Services.createChatCompletion(headers(), body({ response_format: { type: 'json_object' } })),
    ),
  ).rejects.toMatchObject({ status: 400 });

  expect(aiState.generateCalls).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('a stream emits OpenAI chunks and stores the assembled completion after it drains', async () => {
  aiState.streamParts = [
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'stream' },
    {
      type: 'finish',
      finishReason: 'length',
      totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  ];

  const chunks: ChatCompletionChunk[] = [];
  await runWithCaller(callerFixture, async () => {
    for await (const chunk of Services.streamChatCompletion(
      headers(),
      body({ stream: true, stream_options: { include_usage: true } }),
    )) {
      chunks.push(chunk);
    }
  });

  expect(chunks).toHaveLength(5);
  expect(chunks[0]).toMatchObject({ choices: [{ delta: { role: 'assistant', content: '' } }] });
  expect(chunks[1]).toMatchObject({ choices: [{ delta: { content: 'Hello ' } }] });
  expect(chunks[2]).toMatchObject({ choices: [{ delta: { content: 'stream' } }] });
  expect(chunks[3]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'length' }] });
  expect(chunks[4]).toMatchObject({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });

  expect(logCapture.completed[0]?.entry.response).toMatchObject({
    choices: [{ message: { content: 'Hello stream' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  expect(logCapture.failed).toHaveLength(0);
});

test('the HTTP handler exposes successful fixed-window quota headers', async () => {
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ai-api-key': 'upstream-secret',
      'ai-rate-limit-policy': '2;w=60',
    },
    body: JSON.stringify(body()),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('RateLimit-Limit')).toBe('2');
  expect(response.headers.get('RateLimit-Remaining')).toBe('1');
  expect(response.headers.get('X-RateLimit-Limit')).toBe('2');
  expect(aiState.generateCalls).toHaveLength(1);
});

test('the HTTP handler returns quota and retry headers on its own 429 response', async () => {
  rateLimitState.result = {
    limit: 2,
    isLimited: true,
    remainingQuota: 0,
    retryAfterSeconds: 47,
    delaySeconds: null,
  };

  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ai-api-key': 'upstream-secret',
      'ai-rate-limit-policy': '2;w=60',
    },
    body: JSON.stringify(body()),
  });

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('47');
  expect(response.headers.get('RateLimit-Limit')).toBe('2');
  expect(response.headers.get('RateLimit-Remaining')).toBe('0');
  expect(response.headers.get('RateLimit-Reset')).toBe('47');
  expect(aiState.generateCalls).toHaveLength(0);
});
