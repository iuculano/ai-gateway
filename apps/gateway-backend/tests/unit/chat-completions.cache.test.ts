import { beforeEach, expect, mock, test } from 'bun:test';
import { streamText, wrapLanguageModel } from 'ai';
import Schemas from '../../src/api/chat-completions/chat-completions.schemas';
import { cache, callerFixture, database, installModuleMocks, logWrites, modelRow, resetDoubles, rows } from './doubles';

await installModuleMocks();

const { createCacheMiddleware } = await import('../../src/api/chat-completions/chat-completions.cache');

type Model = ReturnType<typeof wrapLanguageModel>;
type CallOptions = Parameters<Model['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<Model['doGenerate']>>;
type StreamResult = Awaited<ReturnType<Model['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

const params: CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  temperature: 0,
};

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 3, noCache: 1, cacheRead: 2, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

const response = {
  id: 'response-1',
  timestamp: new Date('2026-01-02T03:04:05.000Z'),
  modelId: 'test-model',
};

const generateResult: GenerateResult = {
  content: [{ type: 'text', text: 'Hello from the provider' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: usage,
  response: response,
  warnings: [],
};

const streamParts: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', ...response },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello from the provider' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage },
];

const calls = { generate: 0, stream: 0 };

const providerModel = {
  specificationVersion: 'v4' as const,
  provider: 'test-provider',
  modelId: 'test-model',
  supportedUrls: {},

  async doGenerate() {
    calls.generate++;
    return generateResult;
  },

  async doStream() {
    calls.stream++;
    return {
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of streamParts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    };
  },
} satisfies Model;

async function collect(stream: ReadableStream<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

beforeEach(() => {
  resetDoubles();
  calls.generate = 0;
  calls.stream = 0;
});

function cachedModel(model: Model = providerModel, scope = 'test') {
  return wrapLanguageModel({ model, middleware: createCacheMiddleware(scope, { hit: false }) });
}

test('generated results replay with restored timestamps', async () => {
  await cachedModel().doGenerate(params);
  expect(await cachedModel().doGenerate(params)).toEqual(generateResult);
  expect(calls.generate).toBe(1);
});

test('stream chunks are stored after consumption and replayed with restored timestamps', async () => {
  const original = await cachedModel().doStream(params);
  expect(cache.responseWrites).toHaveLength(0);
  expect(await collect(original.stream)).toEqual(streamParts);
  expect(await collect((await cachedModel().doStream(params)).stream)).toEqual(streamParts);
  expect(calls.stream).toBe(1);
});

test('generate, stream, and separate scopes use separate entries', async () => {
  await cachedModel().doGenerate(params);
  await collect((await cachedModel().doStream(params)).stream);
  await collect((await cachedModel(providerModel, 'other').doStream(params)).stream);
  expect(calls).toEqual({ generate: 1, stream: 2 });
});

test('the SDK consumes live and replayed streams with the same text and usage', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = streamText({ model: cachedModel(), prompt: 'Hello' });
    await result.consumeStream();
    expect(await result.text).toBe('Hello from the provider');
    expect((await result.totalUsage).totalTokens).toBe(7);
  }
  expect(calls.stream).toBe(1);
});

mock.module('@ai-sdk/openai', () => ({ createOpenAI: () => ({ chat: () => providerModel }) }));
const { runWithCaller } = await import('@repo/hono');
const { default: ChatCompletions } = await import('../../src/api/chat-completions/chat-completions.services');

for (const streaming of [false, true]) {
  test(`${streaming ? 'streamed' : 'generated'} cache hits log zero cost and preserve usage`, async () => {
    database.defaultResponse(
      'select',
      'models',
      rows(
        modelRow({
          provider: 'openai',
          name: 'test-model',
          cost_input: '2',
          cost_output: '8',
        }),
      ),
    );
    database.defaultResponse('select', 'webhooks', rows());
    logWrites.installDefaults();
    const headers = { 'ai-api-key': 'cache-test-secret', 'ai-cache-enabled': true };
    const body = { model: 'openai/test-model', messages: [{ role: 'user' as const, content: 'Hello' }] };
    await runWithCaller(callerFixture, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (streaming) {
          for await (const result of ChatCompletions.streamChatCompletion(headers, body)) {
            expect(result.isOk()).toBe(true);
          }
        } else {
          expect((await ChatCompletions.createChatCompletion(headers, body)).isOk()).toBe(true);
        }
      }
    });
    expect(logWrites.completed[0]?.entry.gateway_cache_hit).toBe(false);
    expect(logWrites.completed[0]?.entry.cached_input_tokens).toBe(2);
    expect(logWrites.completed[0]?.entry.input_cost).toBeCloseTo(0.000006, 15);
    expect(logWrites.completed[0]?.entry.output_cost).toBeCloseTo(0.000032, 15);
    expect(logWrites.completed[1]?.entry).toMatchObject({
      gateway_cache_hit: true,
      input_cost: 0,
      output_cost: 0,
      input_tokens: 3,
      cached_input_tokens: 2,
      output_tokens: 4,
    });
    expect(streaming ? calls.stream : calls.generate).toBe(1);
  });
}

for (const streaming of [false, true]) {
  test(`${streaming ? 'stream' : 'generate'} refresh replaces the entry with the requested TTL`, async () => {
    const invoke = async (model: Model) =>
      streaming ? collect((await model.doStream(params)).stream) : model.doGenerate(params);
    await invoke(cachedModel());
    expect(cache.responseWrites[0]?.options).toEqual({ expiration: { type: 'EX', value: 300 } });
    const reads = cache.responseReads.length;
    const state = { hit: false };
    await invoke(
      wrapLanguageModel({
        model: providerModel,
        middleware: createCacheMiddleware('test', state, { ttl: 60, refresh: true }),
      }),
    );
    expect(state.hit).toBe(false);
    expect(cache.responseReads).toHaveLength(reads);
    expect(cache.responseWrites).toHaveLength(2);
    expect(cache.responseWrites[1]?.key).toBe(cache.responseWrites[0]?.key);
    expect(cache.responseWrites[1]?.options).toEqual({ expiration: { type: 'EX', value: 60 } });
    await invoke(cachedModel());
    expect(streaming ? calls.stream : calls.generate).toBe(2);
  });

  test(`${streaming ? 'stream' : 'generate'} caching is disabled by default, even with refresh and TTL`, async () => {
    database.defaultResponse('select', 'models', rows(modelRow({ provider: 'openai', name: 'test-model' })));
    database.defaultResponse('select', 'webhooks', rows());
    logWrites.installDefaults();
    const body = { model: 'openai/test-model', messages: [{ role: 'user' as const, content: 'Hello' }] };
    await runWithCaller(callerFixture, async () => {
      for (const headers of [
        { 'ai-api-key': 'cache-test-secret' },
        { 'ai-api-key': 'cache-test-secret', 'ai-cache-refresh': true, 'ai-cache-ttl': 60 },
        { 'ai-api-key': 'cache-test-secret', 'ai-cache-enabled': false },
      ]) {
        if (streaming) {
          for await (const result of ChatCompletions.streamChatCompletion(headers, body))
            expect(result.isOk()).toBe(true);
        } else expect((await ChatCompletions.createChatCompletion(headers, body)).isOk()).toBe(true);
      }
    });
    expect(cache.responseReads).toHaveLength(0);
    expect(cache.responseWrites).toHaveLength(0);
    expect(streaming ? calls.stream : calls.generate).toBe(3);
  });
}

test('cache headers parse booleans and positive whole-second TTLs', () => {
  const schema = Schemas.createChatCompletion.headers;
  expect(
    schema.parse({
      'ai-api-key': 'test',
      'ai-cache-enabled': 'true',
      'ai-cache-refresh': 'false',
      'ai-cache-ttl': '60',
    }),
  ).toMatchObject({ 'ai-cache-enabled': true, 'ai-cache-refresh': false, 'ai-cache-ttl': 60 });
  for (const ttl of ['0', '-1', '1.5', 'invalid']) {
    expect(schema.safeParse({ 'ai-api-key': 'test', 'ai-cache-ttl': ttl }).success).toBe(false);
  }
});
