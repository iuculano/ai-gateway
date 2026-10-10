import { beforeEach, expect, mock, test } from 'bun:test';
import { APICallError } from 'ai';
import type { EmbeddingBody, EmbeddingHeaders } from '../../src/api/embeddings/embeddings.schemas';
import {
  callerFixture,
  database,
  installModuleMocks,
  LOG_ID,
  logWrites,
  modelRow,
  objects,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

const embeddingModel = { provider: 'test', modelId: 'test-embedding' };

mock.module('@ai-sdk/openai', () => ({
  createOpenAI: () => ({ embedding: () => embeddingModel }),
}));

const aiState = {
  calls: [] as Record<string, unknown>[],
  error: null as unknown,

  reset() {
    aiState.calls = [];
    aiState.error = null;
  },
};

const actualAi = await import('ai');
mock.module('ai', () => ({
  ...actualAi,

  async embedMany(options: { values: string[] }) {
    aiState.calls.push(options);
    if (aiState.error) {
      throw aiState.error;
    }

    return {
      values: options.values,
      embeddings: options.values.map((_, index) => [index, 0.5, -1]),
      usage: { tokens: 6 },
      warnings: [],
    };
  },
}));

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/embeddings/embeddings.services');

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler, traceContext } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/embeddings/embeddings.handlers');

const httpCaller = {
  ...callerFixture,
  permissions: { scopes: ['embeddings:write'] },
};
const app = new OpenAPIHono();
app.onError(errorHandler());
app.use('*', traceContext());
app.use('*', async (c, next) => {
  c.set('caller', httpCaller);
  // biome-ignore lint/suspicious/noExplicitAny: minimal request logger for handler tests
  c.set('logger', { error() {}, warn() {}, info() {}, debug() {} } as any);
  await next();
});
app.use('*', callerContext());
app.route('/v1', handlers);

// biome-ignore lint/suspicious/noExplicitAny: a sink, not a Logger implementation
const quiet = { error() {}, warn() {}, info() {}, debug() {}, child: () => quiet } as any;

function withCaller<T>(work: () => T): T {
  return runWithCaller(callerFixture, work, { logger: quiet });
}

function headers(overrides: Partial<EmbeddingHeaders> = {}): EmbeddingHeaders {
  return { 'ai-api-key': 'upstream-secret', ...overrides };
}

function body(overrides: Partial<EmbeddingBody> = {}): EmbeddingBody {
  return {
    model: 'openai/test-embedding',
    input: ['first', 'second'],
    ...overrides,
  };
}

beforeEach(() => {
  resetDoubles();
  database.defaultResponse('select', 'models', rows(modelRow({ name: 'test-embedding', cost_input: 0.02 })));
  logWrites.installDefaults();
  aiState.reset();
  httpCaller.permissions = { scopes: ['embeddings:write'] };
});

test('embeddings map to the OpenAI list shape and are logged as an embedding operation', async () => {
  const result = expectOk(
    await withCaller(() =>
      Services.createEmbedding(headers({ 'ai-max-retries': 0 }), body({ dimensions: 3, user: 'u-1' })),
    ),
  );

  expect(result).toEqual({
    object: 'list',
    data: [
      { object: 'embedding', index: 0, embedding: [0, 0.5, -1] },
      { object: 'embedding', index: 1, embedding: [1, 0.5, -1] },
    ],
    model: 'test-embedding',
    usage: { prompt_tokens: 6, total_tokens: 6 },
  });

  expect(aiState.calls[0]).toMatchObject({
    values: ['first', 'second'],
    maxRetries: 0,
    providerOptions: { openai: { dimensions: 3, user: 'u-1' } },
  });

  expect(logWrites.started[0]?.entry).toMatchObject({
    operation: 'embedding',
    model: 'test-embedding',
    provider: 'openai',
    actor_type: 'user',
    actor_id: USER_ID,
  });
  expect(logWrites.completed[0]?.entry).toMatchObject({
    input_tokens: 6,
    request: body({ dimensions: 3, user: 'u-1' }),
    response: result,
  });
  expect(logWrites.completed[0]?.entry.input_cost).toBeCloseTo(0.00000012, 15);
});

test('a single string input is embedded as one value', async () => {
  const result = expectOk(await withCaller(() => Services.createEmbedding(headers(), body({ input: 'only' }))));

  expect(aiState.calls[0]?.values).toEqual(['only']);
  expect(result.data).toHaveLength(1);
});

test('base64 encoding returns little-endian float32 bytes', async () => {
  const result = expectOk(
    await withCaller(() => Services.createEmbedding(headers(), body({ input: 'only', encoding_format: 'base64' }))),
  );

  const encoded = result.data[0]?.embedding as string;
  expect(Array.from(new Float32Array(Buffer.from(encoded, 'base64').buffer))).toEqual([0, 0.5, -1]);
});

test('a provider with no embedding models is refused before any log is opened', async () => {
  database.respondTo('select', 'models', rows(modelRow({ provider: 'anthropic', name: 'claude-embed' })));

  const failure = expectErr(
    await withCaller(() => Services.createEmbedding(headers(), body({ model: 'anthropic/claude-embed' }))),
  );

  expect(failure).toEqual({
    code: 'MODEL_UNSUPPORTED_PROVIDER',
    model: 'anthropic/claude-embed',
    provider: 'anthropic',
  });
  expect(aiState.calls).toHaveLength(0);
  expect(logWrites.started).toHaveLength(0);
});

test('a provider rejection marks the open log failed', async () => {
  aiState.error = new APICallError({
    message: 'bad input',
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });

  const failure = expectErr(await withCaller(() => Services.createEmbedding(headers(), body())));

  expect(failure).toMatchObject({ code: 'PROVIDER_REJECTED_REQUEST', status: 400 });
  expect(logWrites.completed).toHaveLength(0);
  expect(logWrites.failed[0]).toMatchObject({ id: LOG_ID, entry: { request: body() } });
});

test('the HTTP handler returns the list', async () => {
  const response = await app.request('/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'ai-api-key': 'upstream-secret' },
    body: JSON.stringify(body()),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: 'list', model: 'test-embedding' });
});

test('the HTTP handler requires the embeddings:write scope', async () => {
  httpCaller.permissions = { scopes: ['chat-completions:write'] };

  const response = await app.request('/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'ai-api-key': 'upstream-secret' },
    body: JSON.stringify(body()),
  });

  expect(response.status).toBe(403);
  expect(aiState.calls).toHaveLength(0);
  expect(Object.keys(objects.stored)).toHaveLength(0);
});
