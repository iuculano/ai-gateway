import { beforeEach, expect, mock, test } from 'bun:test';
import type { Experimental_DecisionModelV4Result } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import type {
  CreateDecisionBody,
  CreateDecisionHeaders,
  CreateDecisionResponse,
} from '../../src/api/decisions/decisions.schemas';
import {
  callerFixture,
  database,
  installModuleMocks,
  LOG_ID,
  logWrites,
  modelRow,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();

/** One fake decision model, handed out by both providers. */
const decisionState = {
  calls: [] as Record<string, unknown>[],
  providers: [] as string[],
  error: null as unknown,
  result: {} as Experimental_DecisionModelV4Result,

  reset() {
    decisionState.calls = [];
    decisionState.providers = [];
    decisionState.error = null;
    decisionState.result = {
      answers: {
        spam: { type: 'boolean', probability: 0.03 },
        route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, sales: 0.1 } },
        urgency: { type: 'score', score: 1.2, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 } },
      },
      usage: { inputTokens: 60, outputTokens: 12 },
      warnings: [],
      providerMetadata: { openai: { confidence: { route: 0.8, urgency: 0.6 } } },
      response: { modelId: 'gpt-6-luna' },
    };
  },
};

function fakeDecisionModel(provider: string) {
  return {
    decisionModel: () => ({
      async doDecide(options: Record<string, unknown>) {
        decisionState.providers.push(provider);
        decisionState.calls.push(options);
        if (decisionState.error) {
          throw decisionState.error;
        }

        return decisionState.result;
      },
    }),
  };
}

mock.module('@ai-sdk/openai', () => ({ createOpenAI: () => fakeDecisionModel('openai') }));
mock.module('@ai-sdk/typesafe-ai', () => ({ createTypeSafeAi: () => fakeDecisionModel('typesafe-ai') }));

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/decisions/decisions.services');

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler, traceContext } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/decisions/decisions.handlers');

const httpCaller = {
  ...callerFixture,
  permissions: { scopes: ['decisions:write'] },
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

function headers(overrides: Partial<CreateDecisionHeaders> = {}): CreateDecisionHeaders {
  return { 'ai-api-key': 'upstream-secret', ...overrides };
}

function body(overrides: Partial<CreateDecisionBody> = {}): CreateDecisionBody {
  return {
    model: 'openai/gpt-6-luna',
    input: 'My invoice was charged twice, please help today.',
    questions: [
      { type: 'predicate', name: 'spam', instructions: 'Is this spam?' },
      {
        type: 'choice',
        name: 'route',
        instructions: 'Which team should handle this?',
        choices: [
          { value: 'billing', description: 'Payments and invoices' },
          { value: 'sales', description: 'New purchases' },
        ],
      },
      {
        type: 'score',
        name: 'urgency',
        instructions: 'How urgent is this?',
        levels: [
          { label: 'low', description: 'Can wait a week' },
          { label: 'medium', description: 'Within a day' },
          { label: 'high', description: 'Right now' },
        ],
      },
    ],
    ...overrides,
  };
}

const expectedAnswers: CreateDecisionResponse['answers'] = [
  { type: 'predicate', name: 'spam', probability: 0.03 },
  {
    type: 'choice',
    name: 'route',
    choice: 'billing',
    probabilities: [
      { value: 'billing', probability: 0.9 },
      { value: 'sales', probability: 0.1 },
    ],
    confidence: 0.8,
  },
  {
    type: 'score',
    name: 'urgency',
    score: 1.2,
    probabilities: [
      { value: 0, label: 'low', probability: 0.1 },
      { value: 1, label: 'medium', probability: 0.6 },
      { value: 2, label: 'high', probability: 0.3 },
    ],
    confidence: 0.6,
  },
];

beforeEach(() => {
  resetDoubles();
  database.defaultResponse(
    'select',
    'models',
    rows(modelRow({ name: 'gpt-6-luna', type: 'decision', cost_input: 0.1, cost_output: 0 })),
  );
  logWrites.installDefaults();
  decisionState.reset();
  httpCaller.permissions = { scopes: ['decisions:write'] };
});

test('questions are translated for the SDK and answers come back in the OpenAI shape', async () => {
  const decision = expectOk(
    await withCaller(() => Services.createDecision(headers(), body({ safety_identifier: 'user-1' }))),
  );

  expect(decision).toEqual({
    model: 'gpt-6-luna',
    answers: expectedAnswers,
    usage: { input_tokens: 60, output_tokens: 12, total_tokens: 72 },
  });

  expect(decisionState.calls[0]).toMatchObject({
    state: body().input,
    questions: {
      spam: { type: 'boolean', instructions: 'Is this spam?' },
      route: { type: 'choice', criteria: { billing: 'Payments and invoices', sales: 'New purchases' } },
      urgency: { type: 'score', criteria: ['low: Can wait a week', 'medium: Within a day', 'high: Right now'] },
    },
    providerOptions: { openai: { safetyIdentifier: 'user-1' } },
  });

  expect(logWrites.started[0]?.entry).toMatchObject({
    operation: 'decision',
    model: 'gpt-6-luna',
    provider: 'openai',
    actor_type: 'user',
    actor_id: USER_ID,
  });
});

test('costs come from the decision row, which prices output as free', async () => {
  await withCaller(() => Services.createDecision(headers(), body()));

  const entry = logWrites.completed[0]?.entry;
  expect(entry).toMatchObject({ input_tokens: 60, output_tokens: 12, output_cost: 0 });
  expect(entry?.input_cost).toBeCloseTo(0.000006, 15);
});

test('a refused question comes back as a refusal alongside the other answers', async () => {
  decisionState.result.answers.urgency = { type: 'refusal' };

  const decision = expectOk(await withCaller(() => Services.createDecision(headers(), body())));

  expect(decision.answers).toEqual([...expectedAnswers.slice(0, 2), { type: 'refusal', name: 'urgency' }]);
  expect(logWrites.completed).toHaveLength(1);
});

test('a TypeSafe model answers in the same shape, confidence included', async () => {
  database.respondTo('select', 'models', rows(modelRow({ provider: 'typesafe-ai', name: 'jev-latest' })));
  decisionState.result.providerMetadata = { typesafe: { confidence: { route: 0.8, urgency: 0.6 } } };
  decisionState.result.response = { modelId: 'jev-latest' };

  const decision = expectOk(
    await withCaller(() => Services.createDecision(headers(), body({ model: 'typesafe-ai/jev-latest' }))),
  );

  expect(decisionState.providers).toEqual(['typesafe-ai']);
  expect(decision).toEqual({
    model: 'jev-latest',
    answers: expectedAnswers,
    usage: { input_tokens: 60, output_tokens: 12, total_tokens: 72 },
  });
});

test('a provider with no decision API is refused before any log is opened', async () => {
  database.respondTo('select', 'models', rows(modelRow({ provider: 'anthropic', name: 'claude-decide' })));

  const failure = expectErr(
    await withCaller(() => Services.createDecision(headers(), body({ model: 'anthropic/claude-decide' }))),
  );

  expect(failure).toEqual({
    code: 'MODEL_UNSUPPORTED_PROVIDER',
    model: 'anthropic/claude-decide',
    provider: 'anthropic',
  });
  expect(decisionState.calls).toHaveLength(0);
  expect(logWrites.started).toHaveLength(0);
});

test('a provider rejection marks the open log failed', async () => {
  decisionState.error = new APICallError({
    message: 'bad input',
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });

  const failure = expectErr(await withCaller(() => Services.createDecision(headers(), body())));

  expect(failure).toMatchObject({ code: 'PROVIDER_REJECTED_REQUEST', status: 400 });
  expect(logWrites.completed).toHaveLength(0);
  expect(logWrites.failed[0]).toMatchObject({ id: LOG_ID, entry: { request: body() } });
});

async function post(payload: unknown) {
  return app.request('/v1/decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'ai-api-key': 'upstream-secret' },
    body: JSON.stringify(payload),
  });
}

test('the HTTP handler returns the decision', async () => {
  const response = await post(body());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: 'gpt-6-luna', answers: expectedAnswers });
});

test('the schema rejects duplicate question names and message-array input', async () => {
  const [spam] = body().questions;

  expect((await post(body({ questions: [spam, spam] as CreateDecisionBody['questions'] }))).status).toBe(400);
  expect((await post({ ...body(), input: [{ role: 'user', content: 'hi' }] })).status).toBe(400);
  expect(decisionState.calls).toHaveLength(0);
});

test('the HTTP handler requires the decisions:write scope', async () => {
  httpCaller.permissions = { scopes: ['chat-completions:write'] };

  const response = await post(body());

  expect(response.status).toBe(403);
  expect(decisionState.calls).toHaveLength(0);
});
