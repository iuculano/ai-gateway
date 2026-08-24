import { beforeEach, expect, mock, test } from 'bun:test';
import { APICallError, InvalidArgumentError, InvalidMessageRoleError, InvalidPromptError, RetryError } from 'ai';
import { err, ok, type Result } from 'neverthrow';
import type {
  ChatCompletionBody,
  ChatCompletionChunk,
  ChatCompletionHeaders,
} from '../../src/api/chat-completions/chat-completions.schemas';
import type { GetModelResponse } from '../../src/api/models/models.schemas';
import type { ResolvePromptFailure } from '../../src/api/prompts/prompts.services';
import {
  callerFixture,
  database,
  installModuleMocks,
  LOG_ID,
  logCapture,
  MODEL_ID,
  resetDoubles,
  rows,
  USER_ID,
  WEBHOOK_ID,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const providerModel = { provider: 'test', modelId: 'test-model' };

/**
 * How the provider clients were built, which is the only externally visible
 * evidence of what resolveModel decided - the model instance itself is opaque
 * and identical for both providers here.
 */
const providerFactory = {
  openai: [] as { apiKey: string; baseURL?: string }[],
  azure: [] as { apiKey: string; baseURL?: string }[],

  reset() {
    providerFactory.openai = [];
    providerFactory.azure = [];
  },
};

mock.module('@ai-sdk/openai', () => ({
  createOpenAI: (config: { apiKey: string; baseURL?: string }) => {
    providerFactory.openai.push(config);
    return { chat: () => providerModel };
  },
}));

mock.module('@ai-sdk/azure', () => ({
  createAzure: (config: { apiKey: string; baseURL?: string }) => {
    providerFactory.azure.push(config);
    return { chat: () => providerModel };
  },
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

  /**
   * Handed to the onError callback the service registers, at streamText() time.
   *
   * The SDK reports a mid-generation failure through that callback rather than
   * by rejecting or by ending the iteration, so nothing a fullStream can yield
   * reaches the branch that reads it.
   */
  streamOnError: null as unknown,

  reset() {
    aiState.generateCalls = [];
    aiState.streamCalls = [];
    aiState.generateError = null;
    aiState.streamResponseError = null;
    aiState.streamParts = [];
    aiState.streamOnError = null;
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

  streamText(options: { onError?: (event: { error: unknown }) => void }) {
    aiState.streamCalls.push(options);

    if (aiState.streamOnError) {
      options.onError?.({ error: aiState.streamOnError });
    }

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
const { default: ResultServices } = await import('../../src/api/chat-completions/chat-completions.services');

/**
 * Successful mapping examples are clearer with the value unwrapped. Expected
 * failures use ResultServices directly below and assert the Err as a value.
 */
const Services = {
  ...ResultServices,

  async createChatCompletion(...args: Parameters<typeof ResultServices.createChatCompletion>) {
    return expectOk(await ResultServices.createChatCompletion(...args));
  },

  async *streamChatCompletion(
    ...args: Parameters<typeof ResultServices.streamChatCompletion>
  ): AsyncGenerator<ChatCompletionChunk> {
    for await (const result of ResultServices.streamChatCompletion(...args)) {
      yield expectOk(result);
    }
  },
};

async function completionFailure(...args: Parameters<typeof ResultServices.createChatCompletion>) {
  return expectErr(await ResultServices.createChatCompletion(...args));
}

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

/**
 * What resolvePrompt answers with.
 *
 * Stood in rather than driven through the database double because the handler
 * only cares about the Result it gets back: every failure code maps to its own
 * status, and reaching all five through prompt rows and version rows would be
 * testing prompts.services a second time.
 */
const promptState = {
  calls: [] as unknown[],
  result: null as Result<{ version: number; prompt: string }, ResolvePromptFailure> | null,

  reset() {
    promptState.calls = [];
    promptState.result = null;
  },
};

const actualPromptServices = { ...(await import('../../src/api/prompts/prompts.services')).default };
mock.module('../../src/api/prompts/prompts.services', () => ({
  default: {
    ...actualPromptServices,
    async resolvePrompt(reference: unknown) {
      promptState.calls.push(reference);
      return promptState.result ?? ok({ version: 3, prompt: 'You are terse.' });
    },
  },
}));

function catalogModel(slug: string): GetModelResponse {
  const [provider, name] = slug.split('/');

  return {
    id: MODEL_ID,
    source: 'builtin',
    name: name ?? slug,
    provider: provider ?? 'openai',
    display_name: null,
    status: 'available',
    cost_input: null,
    cost_output: null,
    cost_cache_read: null,
    context_limit: null,
    attachment: false,
    reasoning: false,
    tool_call: false,
    structured_output: false,
    config: {},
    tags: {},
    delisted_at: null,
    synced_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const modelLookupState = {
  calls: [] as string[],
  known: true,
  override: null as Partial<GetModelResponse> | null,

  reset() {
    modelLookupState.calls = [];
    modelLookupState.known = true;
    modelLookupState.override = null;
  },
};

const actualModelServices = { ...(await import('../../src/api/models/models.services')).default };
mock.module('../../src/api/models/models.services', () => ({
  default: {
    ...actualModelServices,
    async getModelBySlug(slug: string) {
      modelLookupState.calls.push(slug);

      if (!modelLookupState.known || slug.split('/').length !== 2) {
        return err({ code: 'MODEL_NOT_FOUND', slug });
      }

      return ok({ ...catalogModel(slug), ...modelLookupState.override });
    },
  },
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

/**
 * A logger that swallows.
 *
 * Several paths here deliberately log-and-continue - an unreachable log store,
 * a webhook fan-out that cannot read its table - and the assertion is that the
 * request survived, not what the line said. Without this the suite prints a
 * page of expected errors and a real one no longer stands out.
 */
// biome-ignore lint/suspicious/noExplicitAny: a sink, not a Logger implementation
const quiet = { error() {}, warn() {}, info() {}, debug() {}, child: () => quiet } as any;

/** runWithCaller with the sink above bound, which is how every test here calls it. */
function withCaller<T>(work: () => T): T {
  return runWithCaller(callerFixture, work, { logger: quiet });
}

beforeEach(() => {
  resetDoubles();
  aiState.reset();
  providerFactory.reset();
  promptState.reset();
  modelLookupState.reset();
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

  const completion = await withCaller(() =>
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
      entry: {
        model: 'test-model',
        provider: 'openai',
        tags: undefined,
        // The row names who spent, taken from the authenticated caller rather
        // than from anything the request supplied.
        actor_type: 'user',
        actor_id: USER_ID,
      },
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

test('the omit headers keep the row and its accounting, and store neither payload', async () => {
  // No header removes the row: a caller that could opt out of being attributed
  // could opt out of a spend limit, and a limit a request header switches off
  // is not a limit. The omit headers suppress only the payloads, which is the
  // privacy interest they actually serve.
  await withCaller(() =>
    Services.createChatCompletion(headers({ 'ai-log-omit-request': true, 'ai-log-omit-response': true }), body()),
  );

  expect(logCapture.started).toEqual([
    {
      organizationId: callerFixture.organization.id,
      entry: {
        model: 'test-model',
        provider: 'openai',
        tags: undefined,
        actor_type: 'user',
        actor_id: USER_ID,
      },
    },
  ]);

  expect(logCapture.completed[0]).toMatchObject({
    id: LOG_ID,
    entry: {
      // Still accounted for.
      input_tokens: 7,
      output_tokens: 4,
      // Both sides suppressed.
      omitRequest: true,
      omitResponse: true,
    },
  });
});

test('catalogue pricing is applied to non-streaming logs, including cached input tokens', async () => {
  modelLookupState.override = {
    cost_input: 2,
    cost_output: 8,
    cost_cache_read: 0.5,
  };

  await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(modelLookupState.calls).toEqual(['openai/test-model']);
  expect(logCapture.completed[0]?.entry.input_cost).toBeCloseTo(0.000011, 15);
  expect(logCapture.completed[0]?.entry.output_cost).toBeCloseTo(0.000032, 15);
});

test('ai-log-omit-request suppresses the request payload on the failure path too', async () => {
  aiState.generateError = Object.assign(new Error('provider timed out'), { name: 'TimeoutError' });

  const failure = await withCaller(() => completionFailure(headers({ 'ai-log-omit-request': true }), body()));

  expect(failure).toMatchObject({ code: 'PROVIDER_TIMEOUT' });

  // A failed call still leaves an attributed row - that is the one somebody
  // reading an error rate needs - with nothing stored from it.
  expect(logCapture.started).toHaveLength(1);
  expect(logCapture.failed[0]).toMatchObject({ id: LOG_ID, entry: { omitRequest: true } });
});

test('a provider timeout returns a typed failure and marks the open log failed', async () => {
  aiState.generateError = Object.assign(new Error('provider timed out'), { name: 'TimeoutError' });

  const failure = await withCaller(() => completionFailure(headers(), body()));

  expect(failure).toMatchObject({ code: 'PROVIDER_TIMEOUT' });

  expect(logCapture.completed).toHaveLength(0);
  expect(logCapture.failed[0]).toMatchObject({
    organizationId: callerFixture.organization.id,
    id: LOG_ID,
    entry: { request: { model: 'openai/test-model' } },
  });
});

test('an unsupported response format is rejected before provider or logging work starts', async () => {
  const failure = await withCaller(() =>
    completionFailure(headers(), body({ response_format: { type: 'json_object' } })),
  );

  expect(failure).toMatchObject({ code: 'UNSUPPORTED_RESPONSE_FORMAT' });

  expect(aiState.generateCalls).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('a stream emits OpenAI chunks and stores the assembled completion after it drains', async () => {
  modelLookupState.override = {
    cost_input: 2,
    cost_output: 8,
    cost_cache_read: null,
  };

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
  await withCaller(async () => {
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
  expect(logCapture.completed[0]?.entry.input_cost).toBeCloseTo(0.000006, 15);
  expect(logCapture.completed[0]?.entry.output_cost).toBeCloseTo(0.000016, 15);
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

// --- model resolution --------------------------------------------------------

test('a provider-prefixed model resolves to that provider and forwards the bare id', async () => {
  await withCaller(() => Services.createChatCompletion(headers(), body({ model: 'azure/my-deployment' })));

  expect(providerFactory.azure).toHaveLength(1);
  expect(providerFactory.openai).toHaveLength(0);
  expect(logCapture.started[0]).toMatchObject({
    entry: { provider: 'azure', model: 'my-deployment' },
  });
});

test('a bare model id is rejected because it is not a catalogue slug', async () => {
  const failure = await withCaller(() => completionFailure(headers(), body({ model: 'gpt-bare' })));

  expect(failure).toEqual({ code: 'MODEL_NOT_FOUND', model: 'gpt-bare' });
  expect(providerFactory.openai).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('an unregistered model is rejected before provider or logging work starts', async () => {
  modelLookupState.known = false;

  const failure = await withCaller(() => completionFailure(headers(), body({ model: 'openai/gpt-unknown' })));

  expect(failure).toEqual({ code: 'MODEL_NOT_FOUND', model: 'openai/gpt-unknown' });
  expect(modelLookupState.calls).toEqual(['openai/gpt-unknown']);
  expect(providerFactory.openai).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('a registered but unsupported provider is rejected before provider or logging work starts', async () => {
  modelLookupState.override = { provider: 'anthropic', name: 'claude-sonnet' };

  const failure = await withCaller(() => completionFailure(headers(), body({ model: 'anthropic/claude-sonnet' })));

  expect(failure).toEqual({
    code: 'UNSUPPORTED_MODEL_PROVIDER',
    model: 'anthropic/claude-sonnet',
    provider: 'anthropic',
  });
  expect(providerFactory.openai).toHaveLength(0);
  expect(providerFactory.azure).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('a model identifier with a provider and no model is a typed refusal', async () => {
  const failure = await withCaller(() => completionFailure(headers(), body({ model: 'openai/' })));

  expect(failure).toMatchObject({ code: 'MODEL_NOT_FOUND', model: 'openai/' });

  expect(logCapture.started).toHaveLength(0);
});

test('the base url override reaches the provider client', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers({ 'ai-base-url': 'https://proxy.test/v1' }),
      body({ model: 'openai/gpt-proxied' }),
    ),
  );

  expect(providerFactory.openai[0]).toMatchObject({
    apiKey: 'upstream-secret',
    baseURL: 'https://proxy.test/v1',
  });
});

test('a second call on the same credential reuses the cached provider client', async () => {
  const request = () =>
    withCaller(() => Services.createChatCompletion(headers(), body({ model: 'openai/gpt-cached' })));

  await request();
  await request();

  // The credential is part of the cache key, so this also proves the cache is
  // not what would hand one caller's client to another.
  expect(providerFactory.openai).toHaveLength(1);

  await withCaller(() =>
    Services.createChatCompletion(
      headers({ 'ai-api-key': 'someone-elses-secret' }),
      body({ model: 'openai/gpt-cached' }),
    ),
  );

  expect(providerFactory.openai).toHaveLength(2);
});

// --- message translation -----------------------------------------------------

test('every OpenAI message role is translated into the SDK message model', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers(),
      body({
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'Be ' },
              { type: 'text', text: 'brief.' },
            ],
          },
          { role: 'developer', content: 'Prefer bullet points.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
            ],
          },
          {
            role: 'assistant',
            content: 'Let me look it up.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'a cat' },
        ],
      }),
    ),
  );

  expect((aiState.generateCalls[0] as { messages: unknown[] }).messages).toEqual([
    // Array content is flattened, and `developer` folds onto system because the
    // SDK has no separate role for it.
    { role: 'system', content: 'Be brief.' },
    { role: 'system', content: 'Prefer bullet points.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', image: 'https://example.test/cat.png' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look it up.' },
        // The arguments string is parsed, which is the shape the SDK wants.
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { q: 'cat' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          // Recovered from the assistant turn above - OpenAI's tool message
          // carries only the id.
          toolName: 'lookup',
          output: { type: 'text', value: 'a cat' },
        },
      ],
    },
  ]);
});

test('a tool-calls-only assistant turn carries no empty text part', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers(),
      body({
        messages: [
          { role: 'user', content: 'Look it up' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'lookup', arguments: 'not json' } }],
          },
          { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'result' }] },
        ],
      }),
    ),
  );

  const { messages } = aiState.generateCalls[0] as { messages: { role: string; content: unknown }[] };

  expect(messages[1]).toEqual({
    role: 'assistant',
    content: [
      // Arguments that will not parse fall back to the raw string rather than
      // failing the request - a model is free to emit invalid JSON.
      { type: 'tool-call', toolCallId: 'call_2', toolName: 'lookup', input: 'not json' },
    ],
  });
});

test('a tool result no assistant turn asked for is a typed refusal', async () => {
  const failure = await withCaller(() =>
    completionFailure(
      headers(),
      body({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', tool_call_id: 'call_orphan', content: 'result' },
        ],
      }),
    ),
  );

  expect(failure).toMatchObject({ code: 'UNKNOWN_TOOL_CALL' });

  expect(aiState.generateCalls).toHaveLength(0);
});

// --- request parameters ------------------------------------------------------

test('top_logprobs without logprobs is refused rather than quietly dropped', async () => {
  const failure = await withCaller(() => completionFailure(headers(), body({ top_logprobs: 3 })));

  expect(failure).toMatchObject({ code: 'TOP_LOGPROBS_REQUIRES_LOGPROBS' });

  expect(aiState.generateCalls).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('response_format text is accepted, since it is what the gateway already does', async () => {
  await withCaller(() => Services.createChatCompletion(headers(), body({ response_format: { type: 'text' } })));

  expect(aiState.generateCalls).toHaveLength(1);
});

test('max_completion_tokens supersedes max_tokens, and the timeout header rides along', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers({ 'ai-timeout-ms': 4500 }),
      body({
        max_tokens: 100,
        max_completion_tokens: 250,
        stop: ['END', 'STOP'],
        presence_penalty: 0,
        frequency_penalty: 0,
      }),
    ),
  );

  expect(aiState.generateCalls[0]).toMatchObject({
    maxOutputTokens: 250,
    stopSequences: ['END', 'STOP'],
    presencePenalty: 0,
    frequencyPenalty: 0,
    timeout: 4500,
  });
});

test('settings with no cross-provider equivalent ride in the openai namespace', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers(),
      body({
        logit_bias: { '1234': -50 },
        logprobs: true,
        top_logprobs: 5,
        metadata: { run: 'nightly' },
        parallel_tool_calls: false,
        prediction: { type: 'content', content: 'draft' },
        prompt_cache_key: 'cache-me',
        prompt_cache_retention: 'in-memory',
        reasoning_effort: 'high',
        safety_identifier: 'user-7',
        service_tier: 'flex',
        store: true,
        user: 'alex',
        verbosity: 'low',
      }),
    ),
  );

  expect((aiState.generateCalls[0] as { providerOptions: unknown }).providerOptions).toEqual({
    openai: {
      logitBias: { '1234': -50 },
      // One field upstream: the number of alternatives when asked for.
      logprobs: 5,
      metadata: { run: 'nightly' },
      parallelToolCalls: false,
      prediction: { type: 'content', content: 'draft' },
      promptCacheKey: 'cache-me',
      // Underscored on the way out; the wire spelling is hyphenated.
      promptCacheRetention: 'in_memory',
      reasoningEffort: 'high',
      safetyIdentifier: 'user-7',
      serviceTier: 'flex',
      store: true,
      user: 'alex',
      textVerbosity: 'low',
    },
  });
});

test('logprobs without a count asks for the chosen token, and 24h retention passes through', async () => {
  await withCaller(() =>
    Services.createChatCompletion(headers(), body({ logprobs: true, prompt_cache_retention: '24h' })),
  );

  expect((aiState.generateCalls[0] as { providerOptions: unknown }).providerOptions).toEqual({
    openai: { logprobs: true, promptCacheRetention: '24h' },
  });
});

test('a request with no provider-specific settings sends no providerOptions at all', async () => {
  await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(aiState.generateCalls[0]).not.toHaveProperty('providerOptions');
  expect(aiState.generateCalls[0]).not.toHaveProperty('tools');
});

test('tool definitions become an SDK tool set with no executor', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers(),
      body({
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look something up',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
          // No parameters: the gateway supplies an empty object schema rather
          // than sending nothing.
          { type: 'function', function: { name: 'ping' } },
        ],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      }),
    ),
  );

  const call = aiState.generateCalls[0] as { tools: Record<string, { execute?: unknown }>; toolChoice: unknown };

  expect(Object.keys(call.tools)).toEqual(['lookup', 'ping']);
  // A gateway forwards tool calls to its caller; running one here would be the
  // wrong side of the boundary.
  expect(call.tools.lookup?.execute).toBeUndefined();
  expect(call.toolChoice).toEqual({ type: 'tool', toolName: 'lookup' });
});

test('a string tool_choice passes through as the SDK spells it', async () => {
  await withCaller(() =>
    Services.createChatCompletion(
      headers(),
      body({
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        tool_choice: 'required',
      }),
    ),
  );

  expect((aiState.generateCalls[0] as { toolChoice: unknown }).toolChoice).toBe('required');
});

test('tools with no tool_choice leave the decision to the model', async () => {
  await withCaller(() =>
    Services.createChatCompletion(headers(), body({ tools: [{ type: 'function', function: { name: 'lookup' } }] })),
  );

  const call = aiState.generateCalls[0] as { tools: Record<string, unknown>; toolChoice: unknown };

  expect(Object.keys(call.tools)).toEqual(['lookup']);
  expect(call.toolChoice).toBeUndefined();
});

test('tool_choice is ignored when the request declared no tools', async () => {
  await withCaller(() => Services.createChatCompletion(headers(), body({ tool_choice: 'auto' })));

  expect(aiState.generateCalls[0]).not.toHaveProperty('toolChoice');
});

// --- response mapping --------------------------------------------------------

test('a tool-call turn reports null content and JSON-string arguments', async () => {
  aiState.generateResult = {
    ...aiState.generateResult,
    text: '',
    finishReason: 'tool-calls',
    toolCalls: [
      { toolCallId: 'call_1', toolName: 'lookup', input: { q: 'cat' } },
      // An input the SDK never populated still has to be a valid JSON string.
      { toolCallId: 'call_2', toolName: 'ping', input: undefined },
    ],
  };

  const completion = await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(completion.choices[0]).toMatchObject({
    finish_reason: 'tool_calls',
    message: {
      // Null, not '' - clients switch on exactly this.
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } },
        { id: 'call_2', type: 'function', function: { name: 'ping', arguments: '{}' } },
      ],
    },
  });
});

test('a content filter stop is reported in OpenAI spelling', async () => {
  aiState.generateResult = { ...aiState.generateResult, finishReason: 'content-filter' };

  const completion = await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(completion.choices[0]?.finish_reason).toBe('content_filter');
});

test('a finish reason outside the OpenAI enum lands on stop', async () => {
  // 'error' and 'other' have no counterpart upstream, and inventing one would
  // break a client that switches on the documented set.
  aiState.generateResult = { ...aiState.generateResult, finishReason: 'other' };

  const completion = await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(completion.choices[0]?.finish_reason).toBe('stop');
});

test('usage the provider left incomplete becomes zeroes and a computed total', async () => {
  aiState.generateResult = {
    ...aiState.generateResult,
    totalUsage: { inputTokens: 9, outputTokens: undefined, totalTokens: undefined },
  };

  const completion = await withCaller(() => Services.createChatCompletion(headers(), body()));

  expect(completion.usage).toEqual({ prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 });
  // Absent rather than zeroed: the provider said nothing about either.
  expect(completion.usage).not.toHaveProperty('prompt_tokens_details');
  expect(completion.usage).not.toHaveProperty('completion_tokens_details');
});

// --- provider failures -------------------------------------------------------

test('provider 4xx and 5xx failures retain enough detail for the handler to map them', async () => {
  const apiError = (statusCode: number) =>
    new APICallError({
      message: 'upstream said no',
      url: 'https://api.openai.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: statusCode,
    });

  aiState.generateError = apiError(401);
  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_REJECTED_REQUEST',
    status: 401,
  });

  aiState.generateError = apiError(503);
  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_FAILED',
  });
});

test('a rate limit exhausted through the retry wrapper still reaches the caller as a 429', async () => {
  // The SDK retries a 429 and then throws a RetryError holding the attempts,
  // not the APICallError itself - so without unwrapping, the status the route
  // documents would be unreachable for upstream limits.
  aiState.generateError = new RetryError({
    message: 'Failed after 3 attempts',
    reason: 'maxRetriesExceeded',
    errors: [
      new APICallError({
        message: 'slow down',
        url: 'https://api.openai.test',
        requestBodyValues: {},
        statusCode: 429,
      }),
      new APICallError({
        message: 'slow down',
        url: 'https://api.openai.test',
        requestBodyValues: {},
        statusCode: 429,
      }),
    ],
  });

  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_REJECTED_REQUEST',
    status: 429,
  });
});

test('a retry sequence ended by an abort is the caller timing out, not a provider verdict', async () => {
  aiState.generateError = new RetryError({
    message: 'Aborted',
    reason: 'abort',
    errors: [new Error('aborted')],
  });

  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_TIMEOUT',
  });
});

test('a request the provider considers malformed is a 400, not an upstream failure', async () => {
  for (const error of [
    new InvalidPromptError({ prompt: {}, message: 'prompt must not be empty' }),
    new InvalidMessageRoleError({ role: 'wizard' }),
    new InvalidArgumentError({ parameter: 'temperature', value: 5, message: 'temperature must be <= 2' }),
  ]) {
    resetDoubles();
    logCapture.passthrough = false;
    aiState.generateError = error;

    expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
      code: 'PROVIDER_INVALID_REQUEST',
    });
  }
});

test('an abort surfaces as a 504 and anything unrecognised as a 502', async () => {
  aiState.generateError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_TIMEOUT',
  });

  aiState.generateError = new Error('socket hang up');
  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_FAILED',
  });
});

// --- log lifecycle -----------------------------------------------------------

test('a log store that cannot be reached degrades the record, not the completion', async () => {
  logCapture.startFailure = new Error('logs unreachable');
  let echoedLogId: string | undefined;

  const completion = await withCaller(() =>
    Services.createChatCompletion(headers(), body(), (id) => {
      echoedLogId = id;
    }),
  );

  expect(completion.choices[0]?.message.content).toBe('Hello from the provider');
  // Nothing to echo and nothing to close - the header is omitted rather than
  // pointing at a row that was never written.
  expect(echoedLogId).toBeUndefined();
  expect(logCapture.completed).toHaveLength(0);
});

test('a log store that fails on the way out still returns the completion', async () => {
  logCapture.completeFailure = new Error('object store unreachable');

  const completion = await withCaller(() => Services.createChatCompletion(headers(), body()));

  // Generated and paid for; losing the record of it beats losing the answer.
  expect(completion.choices[0]?.message.content).toBe('Hello from the provider');
  expect(logCapture.completed).toHaveLength(1);
});

test('a failure to mark the log failed does not replace the error the caller needs', async () => {
  aiState.generateError = new Error('socket hang up');
  logCapture.failFailure = new Error('logs unreachable');

  expect(await withCaller(() => completionFailure(headers(), body()))).toMatchObject({
    code: 'PROVIDER_FAILED',
  });

  expect(logCapture.failed).toHaveLength(1);
});

test('log tags are parsed onto the row', async () => {
  await withCaller(() => Services.createChatCompletion(headers({ 'ai-log-tags': 'env:prod,team:core' }), body()));

  expect(logCapture.started[0]).toMatchObject({
    entry: { tags: { env: 'prod', team: 'core' } },
  });
});

// --- webhooks ----------------------------------------------------------------

test('ai-webhook-id queues a delivery before the provider is called', async () => {
  database.script(
    // enqueueDelivery: the webhook lookup, scoped to the caller's organization.
    rows({ id: WEBHOOK_ID }),
    // enqueueDelivery: the outbox insert.
    rows(),
    // closeLog's fan-out: no webhook matched, so nothing more is written.
    rows(),
  );

  await withCaller(() => Services.createChatCompletion(headers({ 'ai-webhook-id': WEBHOOK_ID }), body()));

  expect(aiState.generateCalls).toHaveLength(1);
  expect(logCapture.completed).toHaveLength(1);
});

test('a webhook that is not the caller-s is a typed refusal, and costs nothing upstream', async () => {
  database.script(rows());

  const failure = await withCaller(() => completionFailure(headers({ 'ai-webhook-id': WEBHOOK_ID }), body()));

  expect(failure).toMatchObject({ code: 'WEBHOOK_NOT_FOUND', id: WEBHOOK_ID });

  // Refused before the completion is generated - finding out afterwards would
  // leave the caller with an answer and an error at once.
  expect(aiState.generateCalls).toHaveLength(0);
});

test('a webhook cannot be queued against a log that could not be opened', async () => {
  logCapture.startFailure = new Error('logs unreachable');

  const failure = await withCaller(() => completionFailure(headers({ 'ai-webhook-id': WEBHOOK_ID }), body()));

  expect(failure).toMatchObject({ code: 'WEBHOOK_LOG_UNAVAILABLE' });

  expect(aiState.generateCalls).toHaveLength(0);
});

// --- streaming ---------------------------------------------------------------

test('a streamed tool call is framed by index and reassembled for the log', async () => {
  aiState.streamParts = [
    // Emitted locally the moment streamText() is called, so it proves nothing
    // about the provider and must not open the 200.
    { type: 'start' },
    { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
    { type: 'tool-input-delta', id: 'call_1', delta: '{"q":' },
    { type: 'tool-input-delta', id: 'call_1', delta: '"cat"}' },
    // A fragment for a call that was never announced, and a part with no place
    // in the chunk shape. Neither reaches the wire.
    { type: 'tool-input-delta', id: 'call_unknown', delta: 'dropped' },
    { type: 'reasoning-delta', text: 'thinking' },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  ];

  const chunks: ChatCompletionChunk[] = [];
  await withCaller(async () => {
    for await (const chunk of Services.streamChatCompletion(headers(), body({ stream: true }))) {
      chunks.push(chunk);
    }
  });

  expect(chunks).toHaveLength(5);
  expect(chunks[0]).toMatchObject({ choices: [{ delta: { role: 'assistant', content: '' } }] });
  expect(chunks[1]).toMatchObject({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup' } }] } }],
  });
  expect(chunks[2]).toMatchObject({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
  });
  expect(chunks[3]).toMatchObject({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"cat"}' } }] } }],
  });
  expect(chunks[4]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });

  // Every frame carries the gateway's own id and the model the request asked
  // for, because the provider's metadata is not knowable in time.
  expect(chunks[0]?.id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
  expect(chunks[0]?.model).toBe('test-model');

  // Stored as the same chat.completion a non-streaming call would produce, so
  // a reader never has to know which path wrote the row.
  expect(logCapture.completed[0]?.entry.response).toMatchObject({
    object: 'chat.completion',
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
});

test('a provider that streams nothing still produces a well-formed pair of frames', async () => {
  aiState.streamParts = [];

  const chunks: ChatCompletionChunk[] = [];
  await withCaller(async () => {
    for await (const chunk of Services.streamChatCompletion(
      headers(),
      body({ stream: true, stream_options: { include_usage: true } }),
    )) {
      chunks.push(chunk);
    }
  });

  // The opening frame the caller is owed, then the terminator. No usage frame:
  // it was asked for, but the provider never sent one.
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatchObject({ choices: [{ delta: { role: 'assistant', content: '' } }] });
  expect(chunks[1]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });

  // Zeroes rather than a missing block, so the stored shape is the same either way.
  expect(logCapture.completed[0]?.entry.response).toMatchObject({
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
});

test('an empty text delta opens the stream without emitting a content frame', async () => {
  aiState.streamParts = [
    { type: 'text-delta', text: '' },
    { type: 'text-delta', text: 'Hi' },
  ];

  const chunks: ChatCompletionChunk[] = [];
  await withCaller(async () => {
    for await (const chunk of Services.streamChatCompletion(headers(), body({ stream: true }))) {
      chunks.push(chunk);
    }
  });

  expect(chunks).toHaveLength(3);
  expect(chunks[1]).toMatchObject({ choices: [{ delta: { content: 'Hi' } }] });
});

test('an error frame mid-stream aborts the iteration and marks the log failed', async () => {
  aiState.streamParts = [
    { type: 'text-delta', text: 'Partial' },
    {
      type: 'error',
      error: new APICallError({
        message: 'upstream said no',
        url: 'https://api.openai.test',
        requestBodyValues: {},
        statusCode: 400,
      }),
    },
  ];

  const chunks: ChatCompletionChunk[] = [];
  let failure: unknown;
  await withCaller(async () => {
    for await (const result of ResultServices.streamChatCompletion(headers(), body({ stream: true }))) {
      result.match(
        (chunk) => chunks.push(chunk),
        (error) => {
          failure = error;
        },
      );
    }
  });

  expect(failure).toMatchObject({ code: 'PROVIDER_REJECTED_REQUEST', status: 400 });

  // Returned as Err rather than ending quietly, which would look to the caller
  // like a completion that simply stopped early.
  expect(chunks).toHaveLength(2);
  expect(logCapture.failed[0]).toMatchObject({ id: LOG_ID });
  expect(logCapture.completed).toHaveLength(0);
});

test('a failure reported only through onError is returned once the stream drains', async () => {
  aiState.streamOnError = new APICallError({
    message: 'invalid api key',
    url: 'https://api.openai.test',
    requestBodyValues: {},
    statusCode: 401,
  });
  aiState.streamParts = [{ type: 'finish', finishReason: 'error', totalUsage: {} }];

  let failure: unknown;
  await withCaller(async () => {
    for await (const result of ResultServices.streamChatCompletion(headers(), body({ stream: true }))) {
      if (result.isErr()) {
        failure = result.error;
      }
    }
  });

  expect(failure).toMatchObject({ code: 'PROVIDER_REJECTED_REQUEST', status: 401 });

  expect(logCapture.failed[0]).toMatchObject({ id: LOG_ID });
  expect(logCapture.completed).toHaveLength(0);
});

test('the streaming path refuses an unsupported parameter before opening a log', async () => {
  let failure: unknown;
  await withCaller(async () => {
    for await (const result of ResultServices.streamChatCompletion(
      headers(),
      body({ stream: true, response_format: { type: 'json_object' } }),
    )) {
      if (result.isErr()) {
        failure = result.error;
      }
    }
  });

  expect(failure).toMatchObject({ code: 'UNSUPPORTED_RESPONSE_FORMAT' });

  expect(aiState.streamCalls).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('the streaming path forwards the same settings the whole request does', async () => {
  aiState.streamParts = [{ type: 'finish', finishReason: 'stop', totalUsage: {} }];

  await withCaller(async () => {
    for await (const _chunk of Services.streamChatCompletion(
      headers({ 'ai-max-retries': 2 }),
      body({
        stream: true,
        temperature: 0.5,
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        tool_choice: 'auto',
        user: 'alex',
      }),
    )) {
      // Drained for its effect.
    }
  });

  expect(aiState.streamCalls[0]).toMatchObject({
    temperature: 0.5,
    maxRetries: 2,
    toolChoice: 'auto',
    providerOptions: { openai: { user: 'alex' } },
  });
});

// --- handler: prompt expansion -----------------------------------------------

async function post(requestBody: unknown, extraHeaders: Record<string, string> = {}) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ai-api-key': 'upstream-secret',
      ...extraHeaders,
    },
    body: JSON.stringify(requestBody),
  });
}

test('a named prompt is expanded into a leading system message and the version is echoed', async () => {
  const response = await post(body({ prompt: { name: 'support', variables: { tone: 'warm' } } }));

  expect(response.status).toBe(200);
  // Without this, "what did we actually send" is unanswerable once the active
  // version moves.
  expect(response.headers.get('ai-prompt-version')).toBe('3');
  expect(promptState.calls[0]).toEqual({ name: 'support', variables: { tone: 'warm' } });

  const { messages } = aiState.generateCalls[0] as { messages: { role: string; content: string }[] };
  expect(messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
  expect(messages[1]).toMatchObject({ role: 'user' });

  // `prompt` is the gateway's own field and is dropped on the way through, so
  // the log records the request that was actually sent.
  expect(logCapture.completed[0]?.entry.request).not.toHaveProperty('prompt');
});

test('a request that names no prompt sets no version header and never asks', async () => {
  const response = await post(body());

  expect(response.status).toBe(200);
  expect(response.headers.get('ai-prompt-version')).toBeNull();
  expect(promptState.calls).toHaveLength(0);
});

/**
 * One case per code in the failure union.
 *
 * Typed as ResolvePromptFailure rather than inferred, so adding a variant
 * without a case here is a type error rather than a silently untested status.
 */
const promptFailures: [ResolvePromptFailure['code'], ResolvePromptFailure, number][] = [
  ['PROMPT_FORBIDDEN', { code: 'PROMPT_FORBIDDEN', required: 'prompts:read' }, 403],
  ['PROMPT_NOT_FOUND', { code: 'PROMPT_NOT_FOUND', name: 'support' }, 404],
  ['PROMPT_NO_ACTIVE_VERSION', { code: 'PROMPT_NO_ACTIVE_VERSION', name: 'support' }, 422],
  ['PROMPT_VERSION_NOT_FOUND', { code: 'PROMPT_VERSION_NOT_FOUND', name: 'support', version: 9 }, 404],
  [
    'PROMPT_VARIABLES_MISSING',
    { code: 'PROMPT_VARIABLES_MISSING', name: 'support', version: 3, missing: ['tone'] },
    422,
  ],
];

test.each(promptFailures)('a prompt that will not expand is a %s response', async (_code, failure, status) => {
  promptState.result = err(failure);

  const response = await post(body({ prompt: { name: 'support' } }));

  expect(response.status).toBe(status);
  // Refused before anything reaches the provider and before a stream could
  // commit a 200 that can no longer be taken back.
  expect(aiState.generateCalls).toHaveLength(0);
  expect(logCapture.started).toHaveLength(0);
});

test('a forbidden prompt challenges for the scope it needs rather than failing the endpoint', async () => {
  promptState.result = err({ code: 'PROMPT_FORBIDDEN', required: 'prompts:read' });

  const response = await post(body({ prompt: { name: 'support' } }));

  expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="prompts:read"');
});

// --- handler: streaming ------------------------------------------------------

test('the HTTP handler frames a stream as SSE and terminates it with [DONE]', async () => {
  aiState.streamParts = [
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'stream' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  ];

  const response = await post(body({ stream: true }));

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  // Set from the first chunk, which the handler pulls before the stream opens -
  // once it does, the 200 and its headers are on the wire for good.
  expect(response.headers.get('ai-log-id')).toBe(LOG_ID);

  const frames = (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => frame.slice('data: '.length));

  expect(frames.at(-1)).toBe('[DONE]');
  expect(frames).toHaveLength(5);
  expect(JSON.parse(frames[1] ?? '')).toMatchObject({ choices: [{ delta: { content: 'Hello ' } }] });
  expect(logCapture.completed[0]?.entry.response).toMatchObject({
    choices: [{ message: { content: 'Hello stream' } }],
  });
});

test('a failure before the first chunk is still a normal error response, not a broken stream', async () => {
  aiState.streamOnError = new APICallError({
    message: 'invalid api key',
    url: 'https://api.openai.test',
    requestBodyValues: {},
    statusCode: 401,
  });
  aiState.streamParts = [];

  const response = await post(body({ stream: true }));

  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).not.toContain('text/event-stream');
});

test('the non-streaming handler echoes the log id it opened', async () => {
  const response = await post(body());

  expect(response.status).toBe(200);
  expect(response.headers.get('ai-log-id')).toBe(LOG_ID);
  await expect(response.json()).resolves.toMatchObject({
    object: 'chat.completion',
    choices: [{ message: { content: 'Hello from the provider' } }],
  });
});
