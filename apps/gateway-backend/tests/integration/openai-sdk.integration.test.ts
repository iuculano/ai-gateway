import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { callerContext, errorHandler, traceContext } from '@repo/hono';
import OpenAI from 'openai';
import handlers from '../../src/api/chat-completions/chat-completions.handlers';
import decisionHandlers from '../../src/api/decisions/decisions.handlers';
import embeddingHandlers from '../../src/api/embeddings/embeddings.handlers';
import LogServices from '../../src/api/logs/logs.services';
import responseHandlers from '../../src/api/responses/responses.handlers';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

/**
 * The real openai client against the real chat completions handler, AI SDK and
 * OpenAI provider, with a local stand-in for OpenAI behind it. If the official
 * SDK is happy here, callers using it are.
 *
 */

type UpstreamBody = Record<string, unknown> & { stream?: boolean };

const upstream = {
  requests: [] as UpstreamBody[],
  respond: (_body: UpstreamBody): Response => Response.json({}),
};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as UpstreamBody;
    upstream.requests.push(body);
    return upstream.respond(body);
  },
});

const USAGE = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };

function completion(message: Record<string, unknown>, finishReason = 'stop') {
  return Response.json({
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', refusal: null, ...message },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: USAGE,
  });
}

/** An SSE response from frames, with [DONE] unless the stream is cut short. */
function sse(frames: unknown[], done = true) {
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (done) lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: 'test-model',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function upstreamError(status: number, error: Record<string, unknown>) {
  return Response.json({ error: { param: null, ...error } }, { status });
}

/** A log's accounting, once queued writes have landed. Costs come back as numbers or null. */
// Each request here gets its own trace, so its trace id finds its log row.
// Without one, the latest row.
async function logRow(traceId?: string | null) {
  await LogServices.waitForLogWrites();
  const [row] = await admin`
    select status, input_tokens, output_tokens, input_cost::float8 as input_cost, output_cost::float8 as output_cost, gateway_cache_hit
    from logs
    ${traceId === undefined ? admin`` : admin`where trace_id = ${traceId}`}
    order by created_at desc
    limit 1
  `;
  return row;
}

let tenant: Tenant;
let client: OpenAI;
let app: OpenAPIHono;

/** A client for the gateway, in-process unless a real server's URL is given. */
function clientFor(baseURL?: string) {
  return new OpenAI({
    apiKey: 'gateway-key-unchecked-here',
    baseURL: baseURL ?? 'http://gateway.test/v1',
    maxRetries: 0,
    defaultHeaders: { 'ai-api-key': 'upstream-key', 'ai-base-url': `http://localhost:${server.port}/v1` },
    ...(baseURL ? {} : { fetch: async (url: RequestInfo | URL, init?: RequestInit) => app.request(String(url), init) }),
  });
}

beforeAll(async () => {
  await prepareSuite();
});

afterAll(() => {
  server.stop(true);
});

// Log writes are queued, and one landing after the next test's reset would
// reference an organization that no longer exists.
afterEach(async () => {
  await LogServices.waitForLogWrites();
});

beforeEach(async () => {
  await resetDatabase();
  tenant = await seedTenant('openai-sdk');
  await admin`
    insert into models (name, provider, cost_input, cost_output)
    values ('test-model', 'openai', 1, 2), ('gpt-6-luna', 'openai', 0.1, 0.5),
      ('unpriced-model', 'openai', null, null), ('or-model', 'openrouter', 1, 3)
  `;
  await admin`insert into models (name, provider, type, cost_input) values ('embed-model', 'openai', 'embedding', 0.5)`;
  await admin`insert into models (name, provider, type, cost_input) values ('gpt-6-luna', 'openai', 'decision', 0.1)`;
  upstream.requests = [];

  app = new OpenAPIHono();
  app.onError(errorHandler());
  app.use('*', traceContext());
  app.use('*', async (c, next) => {
    c.set('caller', callerFor(tenant, ['chat-completions:write', 'embeddings:write', 'decisions:write']));
    await next();
  });
  app.use('*', callerContext());
  app.route('/v1', handlers);
  app.route('/v1', responseHandlers);
  app.route('/v1', embeddingHandlers);
  app.route('/v1', decisionHandlers);

  client = clientFor();
});

test('create returns what the SDK expects, and echoes the trace id', async () => {
  upstream.respond = () => completion({ content: 'Hello there' });

  const { data, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();

  expect(data.choices[0]?.message.content).toBe('Hello there');
  expect(data.choices[0]?.finish_reason).toBe('stop');
  expect(data.usage).toMatchObject(USAGE);
  expect(response.headers.get('ai-trace-id')).toMatch(/^[0-9a-f]{32}$/);
});

test('request settings reach the provider as OpenAI sent them', async () => {
  upstream.respond = () => completion({ content: 'ok' });

  await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ],
    temperature: 0.2,
    max_completion_tokens: 50,
    stop: ['END'],
    seed: 7,
    user: 'user-1',
  });

  const sent = upstream.requests[0];
  expect(sent).toMatchObject({
    model: 'test-model',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ],
    temperature: 0.2,
    stop: ['END'],
    seed: 7,
    user: 'user-1',
  });
  // The SDK sends max_completion_tokens to the models that need it, and max_tokens to the rest.
  expect(sent?.max_completion_tokens ?? sent?.max_tokens).toBe(50);
});

test('a stream reads as text, ends cleanly, and includes usage when asked', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({}, 'stop', USAGE),
    ]);

  const stream = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });

  let text = '';
  let usage: unknown = null;
  let finishReason: string | null = null;
  for await (const part of stream) {
    text += part.choices[0]?.delta.content ?? '';
    finishReason = part.choices[0]?.finish_reason ?? finishReason;
    usage = part.usage ?? usage;
  }

  expect(text).toBe('Hello');
  expect(finishReason).toBe('stop');
  expect(usage).toMatchObject(USAGE);
});

test('the SDK stream helper assembles a final message', async () => {
  upstream.respond = () =>
    sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Done' }), chunk({}, 'stop', USAGE)]);

  const runner = client.chat.completions.stream({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const final = await runner.finalChatCompletion();

  expect(final.choices[0]?.message.content).toBe('Done');
});

const lookupOrder = {
  type: 'function' as const,
  function: {
    name: 'lookup_order',
    description: 'Look up an order.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

test('a tool call round trip works, unstreamed', async () => {
  upstream.respond = () =>
    completion(
      {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"id":"A1"}' } }],
      },
      'tool_calls',
    );

  const first = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Where is A1?' }],
    tools: [lookupOrder],
  });
  const call = first.choices[0]?.message.tool_calls?.[0];
  expect(first.choices[0]?.finish_reason).toBe('tool_calls');
  expect(call).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'lookup_order' } });
  expect(JSON.parse(call?.type === 'function' ? call.function.arguments : '{}')).toEqual({ id: 'A1' });

  upstream.respond = () => completion({ content: 'It ships tomorrow.' });
  const second = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [
      { role: 'user', content: 'Where is A1?' },
      first.choices[0]?.message as OpenAI.Chat.ChatCompletionMessageParam,
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
    ],
    tools: [lookupOrder],
  });

  expect(second.choices[0]?.message.content).toBe('It ships tomorrow.');
  expect(upstream.requests[1]?.messages).toMatchObject([
    { role: 'user' },
    { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', tool_call_id: 'call_1' },
  ]);
});

test('a streamed tool call is assembled by the SDK stream helper', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: null }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"A1"}' } }] }),
      chunk({}, 'tool_calls', USAGE),
    ]);

  const final = await client.chat.completions
    .stream({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Where is A1?' }], tools: [lookupOrder] })
    .finalChatCompletion();

  const call = final.choices[0]?.message.tool_calls?.[0];
  expect(final.choices[0]?.finish_reason).toBe('tool_calls');
  expect(call?.type === 'function' ? JSON.parse(call.function.arguments) : null).toEqual({ id: 'A1' });
});

test('a model the catalog does not have is a 404 the SDK raises', async () => {
  const error = await client.chat.completions
    .create({ model: 'openai/not-in-catalog', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OpenAI.NotFoundError);
  expect(upstream.requests).toHaveLength(0);
});

test('an upstream 401 raises AuthenticationError', async () => {
  upstream.respond = () =>
    upstreamError(401, {
      message: 'Incorrect API key provided',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    });

  const error = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OpenAI.AuthenticationError);
});

test('an upstream 429 raises RateLimitError', async () => {
  upstream.respond = () =>
    upstreamError(429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' });

  const error = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OpenAI.RateLimitError);
  // The gateway leaves retrying to the client, which retries on its own.
  expect(upstream.requests).toHaveLength(1);
});

test('errors keep the OpenAI type and code clients branch on', async () => {
  upstream.respond = () =>
    upstreamError(400, {
      message: "This model's maximum context length is 128000 tokens.",
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
    });

  const error = (await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.code).toBe('context_length_exceeded');
  expect(error.type).toBe('invalid_request_error');
});

test('a provider failure after the stream opens raises in the SDK, not a silently short answer', async () => {
  // The upstream starts answering, then reports an error and stops.
  upstream.respond = () =>
    sse(
      [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Partial' }),
        { error: { message: 'Upstream overloaded', type: 'server_error' } },
      ],
      false,
    );

  const stream = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  });

  let threw = false;
  try {
    for await (const _part of stream) {
      // drain
    }
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('json_schema structured output is supported', async () => {
  upstream.respond = () => completion({ content: '{"city":"Paris"}' });

  const result = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Capital of France?' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    },
  });

  expect(JSON.parse(result.choices[0]?.message.content ?? '')).toEqual({ city: 'Paris' });
  expect(upstream.requests[0]?.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'answer' } });
});

test('json_object output is supported', async () => {
  upstream.respond = () => completion({ content: '{"ok":true}' });

  const result = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Reply in JSON.' }],
    response_format: { type: 'json_object' },
  });

  expect(JSON.parse(result.choices[0]?.message.content ?? '')).toEqual({ ok: true });
  expect(upstream.requests[0]?.response_format).toEqual({ type: 'json_object' });
});

test('json output that is not valid JSON still comes back as the provider wrote it', async () => {
  // Cut off by max_tokens, say. OpenAI hands back what the model wrote, and so does the gateway.
  upstream.respond = () => completion({ content: '{"ok":tr' });

  const result = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Reply in JSON.' }],
    response_format: { type: 'json_object' },
  });

  expect(result.choices[0]?.message.content).toBe('{"ok":tr');
});

test('logprobs are not supported yet, so they come back null and are not asked for', async () => {
  const logprobs = { content: [{ token: 'Hi', logprob: -0.1, bytes: [72, 105], top_logprobs: [] }], refusal: null };
  upstream.respond = () =>
    Response.json({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 1_790_000_000,
      model: 'test-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hi', refusal: null }, logprobs, finish_reason: 'stop' },
      ],
      usage: USAGE,
    });

  const result = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    logprobs: true,
  });

  expect(result.choices[0]?.logprobs).toBeNull();
  expect(upstream.requests[0]).not.toHaveProperty('logprobs');
});

test('a malformed request is a 400 naming the field at fault', async () => {
  const error = (await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'wizard', content: 'Hi' }] } as never)
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.type).toBe('invalid_request_error');
  expect(error.param).toStartWith('messages');
});

test('the gateway adds no reasoning_effort the caller did not send', async () => {
  upstream.respond = () => completion({ content: 'ok' });

  await client.chat.completions.create({
    model: 'openai/gpt-6-luna',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [lookupOrder],
  });

  expect(upstream.requests[0]).not.toHaveProperty('reasoning_effort');
});

test('a stream the client abandons still runs to the end, and is logged incomplete with its real usage', async () => {
  // Slow enough that the client has left before the upstream finishes.
  upstream.respond = () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Par' }))}\n\n`),
          );
          await Bun.sleep(300);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 'tial' }))}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, 'stop', USAGE))}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };

  // A real server, so leaving behaves like a dropped connection.
  const gateway = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  const abort = new AbortController();
  const { data: stream, response } = await clientFor(`http://localhost:${gateway.port}/v1`)
    .chat.completions.create(
      { model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true },
      { signal: abort.signal },
    )
    .withResponse();
  const traceId = response.headers.get('ai-trace-id');

  await stream[Symbol.asyncIterator]().next();
  abort.abort();
  await Bun.sleep(500);
  await LogServices.waitForLogWrites();

  gateway.stop(true);

  // The provider billed the whole answer, so the log records all of it.
  expect(await logRow(traceId)).toMatchObject({ status: 'incomplete', input_tokens: 12, output_tokens: 4 });
});

// The Responses API, as a translation over the same chat path.

test('responses: create returns output text, usage and a completed status', async () => {
  upstream.respond = () => completion({ content: 'Hello there' });

  const response = await client.responses.create({
    model: 'openai/test-model',
    instructions: 'Be brief.',
    input: 'Hi',
  });

  expect(response.status).toBe('completed');
  expect(response.output_text).toBe('Hello there');
  expect(response.usage).toMatchObject({ input_tokens: 12, output_tokens: 4, total_tokens: 16 });
  expect(upstream.requests[0]?.messages).toMatchObject([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi' },
  ]);
});

const lookupOrderTool = {
  type: 'function' as const,
  name: 'lookup_order',
  description: 'Look up an order.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  strict: false,
};

test('responses: a function call comes back as an item, and its output goes back as history', async () => {
  upstream.respond = () =>
    completion(
      {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"id":"A1"}' } }],
      },
      'tool_calls',
    );

  const first = await client.responses.create({
    model: 'openai/test-model',
    input: 'Where is A1?',
    tools: [lookupOrderTool],
  });
  const call = first.output.find((item) => item.type === 'function_call');
  expect(call).toMatchObject({
    type: 'function_call',
    call_id: 'call_1',
    name: 'lookup_order',
    arguments: '{"id":"A1"}',
  });

  upstream.respond = () => completion({ content: 'It ships tomorrow.' });
  const second = await client.responses.create({
    model: 'openai/test-model',
    input: [
      { role: 'user', content: 'Where is A1?' },
      ...first.output,
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"shipped"}' },
    ] as OpenAI.Responses.ResponseInput,
    tools: [lookupOrderTool],
  });

  expect(second.output_text).toBe('It ships tomorrow.');
  expect(upstream.requests[1]?.messages).toMatchObject([
    { role: 'user', content: 'Where is A1?' },
    { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'lookup_order' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
  ]);
});

test('responses: the SDK stream helper assembles text and reports usage', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({}, 'stop', USAGE),
    ]);

  const stream = client.responses.stream({ model: 'openai/test-model', input: 'Hi' });
  const deltas: string[] = [];
  stream.on('response.output_text.delta', (event) => deltas.push(event.delta));
  const final = await stream.finalResponse();

  expect(deltas).toEqual(['Hel', 'lo']);
  expect(final.output_text).toBe('Hello');
  expect(final.usage?.total_tokens).toBe(16);
});

test('responses: a streamed function call is assembled by the SDK stream helper', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: null }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"A1"}' } }] }),
      chunk({}, 'tool_calls', USAGE),
    ]);

  const final = await client.responses
    .stream({ model: 'openai/test-model', input: 'Where is A1?', tools: [lookupOrderTool] })
    .finalResponse();

  expect(final.output).toMatchObject([
    { type: 'function_call', call_id: 'call_1', name: 'lookup_order', arguments: '{"id":"A1"}' },
  ]);
});

test('responses: text.format json_schema asks the provider for structured output', async () => {
  upstream.respond = () => completion({ content: '{"city":"Paris"}' });

  const response = await client.responses.create({
    model: 'openai/test-model',
    input: 'Capital of France?',
    text: {
      format: {
        type: 'json_schema',
        name: 'answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    },
  });

  expect(JSON.parse(response.output_text)).toEqual({ city: 'Paris' });
  expect(upstream.requests[0]?.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'answer' } });
});

test('responses: an answer cut off by max_output_tokens is incomplete, and says why', async () => {
  upstream.respond = () => completion({ content: 'Partial' }, 'length');

  const response = await client.responses.create({ model: 'openai/test-model', input: 'Hi', max_output_tokens: 5 });

  expect(response.status).toBe('incomplete');
  expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
});

test('responses: previous_response_id is a clear 400, not silently dropped', async () => {
  const error = await client.responses
    .create({ model: 'openai/test-model', input: 'And then?', previous_response_id: 'resp_earlier' })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(upstream.requests).toHaveLength(0);
});

test('responses: a provider failure after the stream opens raises in the SDK', async () => {
  upstream.respond = () =>
    sse(
      [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Partial' }),
        { error: { message: 'Upstream overloaded', type: 'server_error' } },
      ],
      false,
    );

  const failure = await client.responses
    .stream({ model: 'openai/test-model', input: 'Hi' })
    .finalResponse()
    .catch((caught: unknown) => caught);

  expect(failure).toBeInstanceOf(OpenAI.APIError);
});

// Accounting: the tokens and cost stored must be what the provider billed, and
// unknown must never be stored as zero.

test('accounting: a normal call stores its exact tokens and cost', async () => {
  upstream.respond = () => completion({ content: 'Hello there' });

  const { response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();

  // 12 input at $1/M and 4 output at $2/M.
  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({
    status: 'complete',
    input_tokens: 12,
    output_tokens: 4,
    input_cost: 0.000012,
    output_cost: 0.000008,
  });
});

test('accounting: a caller who leaves an unstreamed call is still billed, so its usage is recorded', async () => {
  // Answers after the caller has gone.
  upstream.respond = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          await Bun.sleep(300);
          const body = {
            id: 'chatcmpl-upstream',
            object: 'chat.completion',
            created: 1_790_000_000,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Late' }, finish_reason: 'stop' }],
            usage: USAGE,
          };
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

  const gateway = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  const abort = new AbortController();
  const pending = clientFor(`http://localhost:${gateway.port}/v1`)
    .chat.completions.create(
      { model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] },
      { signal: abort.signal },
    )
    .catch(() => null);
  await Bun.sleep(100);
  abort.abort();
  await pending;
  await Bun.sleep(500);
  gateway.stop(true);

  expect(await logRow()).toMatchObject({
    status: 'incomplete',
    input_tokens: 12,
    output_tokens: 4,
    input_cost: 0.000012,
  });
});

test('accounting: usage the provider left out is stored as unknown, never zero', async () => {
  upstream.respond = () =>
    Response.json({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 1_790_000_000,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    });

  const { data, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();

  expect(data.usage).toBeUndefined();
  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({
    status: 'complete',
    input_tokens: null,
    output_tokens: null,
    input_cost: null,
    output_cost: null,
  });
});

test('accounting: a stream without usage is stored as unknown, never zero', async () => {
  upstream.respond = () =>
    sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hello' }), chunk({}, 'stop')]);

  const { data: stream, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    .withResponse();
  for await (const _part of stream) {
    // drain
  }

  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({ input_tokens: null, input_cost: null });
});

test('accounting: a stream the provider cuts off raises in the SDK and is logged failed', async () => {
  upstream.respond = () => sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' })], false);

  const { data: stream, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    .withResponse();
  let threw = false;
  try {
    for await (const _part of stream) {
      // drain
    }
  } catch {
    threw = true;
  }

  expect(threw).toBe(true);
  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({
    status: 'failed',
    input_tokens: null,
    input_cost: null,
  });
});

test('accounting: a model with no price has an unknown cost, not a free one', async () => {
  upstream.respond = () => completion({ content: 'Hi' });

  const { response } = await client.chat.completions
    .create({ model: 'openai/unpriced-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();

  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({
    input_tokens: 12,
    output_tokens: 4,
    input_cost: null,
    output_cost: null,
  });
});

test('accounting: an embedding with no usage keeps its log, with unknown tokens', async () => {
  upstream.respond = () =>
    Response.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'embed-model',
    });

  await client.embeddings.create({ model: 'openai/embed-model', input: 'Hi' });
  expect(await logRow()).toMatchObject({
    status: 'complete',
    input_tokens: null,
    input_cost: null,
  });
});

test('accounting: an embedding stores its tokens, and no output cost', async () => {
  upstream.respond = () =>
    Response.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'embed-model',
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });

  await client.embeddings.create({ model: 'openai/embed-model', input: 'Hi' });
  // 8 tokens at $0.5/M.
  expect(await logRow()).toMatchObject({
    input_tokens: 8,
    input_cost: 0.000004,
    output_cost: 0,
  });
});

const brokenStreams = {
  failed: [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'Partial' }),
    { error: { message: 'Upstream overloaded', type: 'server_error' } },
  ],
  'cut off': [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Partial' })],
};

for (const [name, frames] of Object.entries(brokenStreams)) {
  test(`accounting: a ${name} stream is not cached, so the next request reaches the provider`, async () => {
    upstream.respond = () => sse(frames, false);
    const options = { headers: { 'ai-cache-enabled': 'true' } };

    for (const _attempt of [1, 2]) {
      try {
        const stream = await client.chat.completions.create(
          { model: 'openai/test-model', messages: [{ role: 'user', content: `cache ${name}` }], stream: true },
          options,
        );
        for await (const _part of stream) {
          // drain
        }
      } catch {
        // Both attempts fail. The point is whether the second reached the provider.
      }
    }

    expect(upstream.requests).toHaveLength(2);
  });
}

test('accounting: OpenRouter stores what it says it charged, split the way the catalog splits it', async () => {
  // OpenRouter routed to a pricier upstream: the catalog says $0.000024, it charged $0.0001.
  upstream.respond = () =>
    Response.json({
      id: 'gen-1',
      object: 'chat.completion',
      created: 1_790_000_000,
      model: 'or-model',
      provider: 'Somewhere',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { ...USAGE, cost: 0.0001 },
    });

  const { response } = await client.chat.completions
    .create({ model: 'openrouter/or-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();
  const row = await logRow(response.headers.get('ai-trace-id'));

  // Catalog: 12 x $1/M in, 4 x $3/M out, so half each.
  expect((row?.input_cost ?? 0) + (row?.output_cost ?? 0)).toBeCloseTo(0.0001, 12);
  expect(row?.input_cost).toBeCloseTo(0.00005, 12);
});

test('accounting: OpenRouter streams ask for usage, so their cost is recorded', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hi' }),
      { ...chunk({}, 'stop'), usage: { ...USAGE, cost: 0.0001 } },
    ]);

  const { data: stream, response } = await client.chat.completions
    .create({ model: 'openrouter/or-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    .withResponse();
  for await (const _part of stream) {
    // drain
  }

  expect(upstream.requests[0]?.stream_options).toEqual({ include_usage: true });
  const row = await logRow(response.headers.get('ai-trace-id'));
  expect(row?.input_tokens).toBe(12);
  expect((row?.input_cost ?? 0) + (row?.output_cost ?? 0)).toBeCloseTo(0.0001, 12);
});

// Timeouts: ai-timeout-ms firing must read as a failure, never a finished answer.

/** A stream that starts answering, then stalls for longer than the timeout. */
function stallingStream() {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Par' }))}\n\n`));
        await Bun.sleep(1000);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const shortTimeout = { headers: { 'ai-timeout-ms': '200' } };

test('timeout: mid-stream it raises in the SDK, and the log is failed with unknown usage', async () => {
  upstream.respond = stallingStream;

  const { data: stream, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true }, shortTimeout)
    .withResponse();
  let threw = false;
  try {
    for await (const _part of stream) {
      // drain
    }
  } catch {
    threw = true;
  }

  expect(threw).toBe(true);
  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({ status: 'failed', input_tokens: null });
});

test('timeout: before the first byte of a stream it is a 504, not an empty 200', async () => {
  upstream.respond = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          await Bun.sleep(1000);
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  const error = (await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true }, shortTimeout)
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.APIError);
  expect(error.status).toBe(504);
});

test('timeout: a Responses stream raises instead of completing with a partial answer', async () => {
  upstream.respond = stallingStream;

  const failure = await client.responses
    .stream({ model: 'openai/test-model', input: 'Hi' }, shortTimeout)
    .finalResponse()
    .catch((caught: unknown) => caught);

  expect(failure).toBeInstanceOf(OpenAI.APIError);
});

// Settings that used to be dropped on the way to the provider.

test('strict tools, image detail and the max reasoning effort reach the provider', async () => {
  upstream.respond = () => completion({ content: 'ok' });

  await client.chat.completions.create({
    model: 'openai/gpt-6-luna',
    reasoning_effort: 'max' as never,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.test/cat.png', detail: 'low' } },
        ],
      },
    ],
    tools: [{ type: 'function', function: { ...lookupOrder.function, strict: true } }],
  });

  const sent = upstream.requests[0] as {
    reasoning_effort?: string;
    tools: { function: { strict?: boolean } }[];
    messages: { content: { type: string; image_url?: { detail?: string } }[] }[];
  };
  expect(sent.reasoning_effort).toBe('max');
  expect(sent.tools[0]?.function.strict).toBe(true);
  expect(sent.messages[0]?.content[1]?.image_url?.detail).toBe('low');
});

test('OpenRouter gets the user, parallel tool calls and reasoning effort as its own request fields', async () => {
  upstream.respond = () => completion({ content: 'ok' });

  await client.chat.completions.create({
    model: 'openrouter/or-model',
    messages: [{ role: 'user', content: 'Hi' }],
    user: 'user-1',
    parallel_tool_calls: false,
    reasoning_effort: 'low',
  });

  expect(upstream.requests[0]).toMatchObject({
    user: 'user-1',
    parallel_tool_calls: false,
    reasoning: { effort: 'low' },
    // Asks OpenRouter to report what it charged.
    usage: { include: true },
  });
});

// OpenRouter's cost with and without your own provider key.

const openRouterCalls = [
  // Its own keys: cost is the whole charge, even if the upstream figure is also filled in.
  {
    name: 'on its own keys',
    usage: { cost: 0.0001, is_byok: false, cost_details: { upstream_inference_cost: 0.0001 } },
    total: 0.0001,
  },
  // Your key: cost is only its fee, and the upstream's charge is separate.
  {
    name: 'on your own key',
    usage: { cost: 0.00001, is_byok: true, cost_details: { upstream_inference_cost: 0.0002 } },
    total: 0.00021,
  },
];

for (const call of openRouterCalls) {
  test(`accounting: an OpenRouter call ${call.name} stores exactly what was charged`, async () => {
    upstream.respond = () =>
      Response.json({
        id: 'gen-1',
        object: 'chat.completion',
        created: 1_790_000_000,
        model: 'or-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { ...USAGE, ...call.usage },
      });

    const { response } = await client.chat.completions
      .create({ model: 'openrouter/or-model', messages: [{ role: 'user', content: 'Hi' }] })
      .withResponse();
    const row = await logRow(response.headers.get('ai-trace-id'));

    expect((row?.input_cost ?? 0) + (row?.output_cost ?? 0)).toBeCloseTo(call.total, 12);
  });
}

// Caller-supplied URLs must not reach inside the gateway's own network.

for (const [name, call] of [
  [
    'chat completions',
    () => client.chat.completions.create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] }),
  ],
  [
    'a chat stream',
    () =>
      client.chat.completions.create({
        model: 'openai/test-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
  ],
  ['responses', () => client.responses.create({ model: 'openai/test-model', input: 'Hi' })],
  ['embeddings', () => client.embeddings.create({ model: 'openai/embed-model', input: 'Hi' })],
  [
    'decisions',
    () =>
      client.decisions.create({
        model: 'openai/gpt-6-luna',
        input: 'Hi',
        questions: [{ type: 'predicate', name: 'greeting', instructions: 'Is this a greeting?' }],
      }),
  ],
] as const) {
  test(`a private ai-base-url is refused with a 400 on ${name}, and never called`, async () => {
    // The suite's own setup allows private addresses, since the stand-in provider is local.
    delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    try {
      const error = (await call().catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

      expect(error).toBeInstanceOf(OpenAI.BadRequestError);
      expect(error.type).toBe('invalid_request_error');
      expect(error.message).toContain('ai-base-url');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';
    }
  });
}

// Slow and quiet calls: the server's idle timeout mustn't cut them off.

test('a stream that goes quiet sends keep-alives and finishes', async () => {
  const encoder = new TextEncoder();
  upstream.respond = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Thinking' }))}\n\n`),
          );
          await Bun.sleep(6000);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: ' done' }))}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, 'stop', USAGE))}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  // Bun's default ten second idle timeout, the same as the real gateway.
  const gateway = Bun.serve({ port: 0, fetch: (request, bunServer) => app.fetch(request, bunServer) });
  const response = await fetch(`http://localhost:${gateway.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ai-api-key': 'k',
      'ai-base-url': `http://localhost:${server.port}/v1`,
    },
    body: JSON.stringify({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
  });
  const wire = await response.text();
  gateway.stop(true);

  expect(wire).toContain('Thinking');
  expect(wire).toContain(' done');
  expect(wire).toEndWith('data: [DONE]\n\n');
  // Sent while the provider was quiet, for proxies with idle limits of their own.
  expect(wire).toContain(': keep-alive\n\n');
}, 15_000);

test('an unstreamed call that takes a while outlives the idle timeout', async () => {
  upstream.respond = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          await Bun.sleep(4000);
          const body = {
            id: 'chatcmpl-upstream',
            object: 'chat.completion',
            created: 1_790_000_000,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Slow answer' }, finish_reason: 'stop' }],
            usage: USAGE,
          };
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

  const gateway = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, bunServer) => app.fetch(request, bunServer) });
  const result = await clientFor(`http://localhost:${gateway.port}/v1`).chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  gateway.stop(true);

  expect(result.choices[0]?.message.content).toBe('Slow answer');
}, 15_000);

test('an Azure model without ai-base-url is a 400 that says what is missing', async () => {
  await admin`insert into models (name, provider, cost_input, cost_output) values ('gpt-az', 'azure', 1, 2)`;

  const error = (await new OpenAI({
    apiKey: 'k',
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    defaultHeaders: { 'ai-api-key': 'k' },
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => app.request(String(url), init),
  }).chat.completions
    .create({ model: 'azure/gpt-az', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.message).toContain('ai-base-url');
});

test('a cache lifetime over a day is refused', async () => {
  const error = await client.chat.completions
    .create(
      { model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] },
      { headers: { 'ai-cache-enabled': 'true', 'ai-cache-ttl': '86401' } },
    )
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(upstream.requests).toHaveLength(0);
});

// Other providers through the same OpenAI-shaped endpoint.

test('streamed Claude tool calls with no arguments still carry valid JSON', async () => {
  await admin`insert into models (name, provider, cost_input, cost_output) values ('claude-test', 'anthropic', 3, 15)`;
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
    // Anthropic sends no argument fragments for a tool that takes none.
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: {} },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: {} },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  upstream.respond = () =>
    new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });

  const final = await client.chat.completions
    .stream({
      model: 'anthropic/claude-test',
      messages: [{ role: 'user', content: 'What time is it?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_time', description: 'Now.', parameters: { type: 'object', properties: {} } },
        },
      ],
    })
    .finalChatCompletion();

  expect(final.choices[0]?.finish_reason).toBe('tool_calls');
  expect(final.choices[0]?.message.tool_calls).toMatchObject([
    { id: 'toolu_1', function: { arguments: '{}' } },
    { id: 'toolu_2', function: { arguments: '{}' } },
  ]);

  // The same calls through the Responses API, where each one is its own item.
  const response = await client.responses
    .stream({
      model: 'anthropic/claude-test',
      input: 'What time is it?',
      tools: [{ type: 'function', name: 'get_time', parameters: { type: 'object', properties: {} }, strict: false }],
    })
    .finalResponse();
  expect(response.output).toMatchObject([
    { call_id: 'toolu_1', arguments: '{}' },
    { call_id: 'toolu_2', arguments: '{}' },
  ]);
});

test('Claude gets the reasoning effort, and its prompt-cache writes are priced as writes', async () => {
  await admin`
    insert into models (name, provider, cost_input, cost_output, cost_cache_read, config)
    values ('claude-cache', 'anthropic', 3, 15, 0.3, (${JSON.stringify({ cost_cache_write: 3.75 })}::text)::jsonb)
  `;
  upstream.respond = () =>
    Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-cache',
      content: [{ type: 'text', text: 'Hi.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      // Anthropic's input_tokens leaves out both kinds of cached input.
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 },
    });

  const { data, response } = await client.chat.completions
    .create({
      model: 'anthropic/claude-cache',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'Hello' }],
    })
    .withResponse();

  expect(upstream.requests[0]).toHaveProperty('thinking');
  expect(data.usage).toMatchObject({
    prompt_tokens: 3100,
    prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 1000 },
  });

  // 100 plain at 3, 2000 read at 0.3 and 1000 written at 3.75, per million.
  const row = await logRow(response.headers.get('ai-trace-id'));
  expect(row).toMatchObject({ input_tokens: 3100, output_tokens: 10 });
  expect(row?.input_cost).toBeCloseTo(0.00465, 12);
  expect(row?.output_cost).toBeCloseTo(0.00015, 12);
});

test('Gemini gets the reasoning effort', async () => {
  await admin`insert into models (name, provider, cost_input, cost_output) values ('gemini-2.5-flash', 'google', 1, 2)`;
  upstream.respond = () =>
    Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hi.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    });

  const result = await client.chat.completions.create({
    model: 'google/gemini-2.5-flash',
    reasoning_effort: 'low',
    messages: [{ role: 'user', content: 'Hello' }],
  });

  expect(result.choices[0]?.message.content).toBe('Hi.');
  expect(upstream.requests[0]).toMatchObject({ generationConfig: { thinkingConfig: {} } });
});

test('an image the gateway cannot fetch is a 400 naming the problem, not a provider failure', async () => {
  await admin`insert into models (name, provider, cost_input, cost_output) values ('gemini-test', 'google', 1, 2)`;

  // Google models can't fetch a URL themselves, so the gateway downloads it, and it refuses this one.
  const error = (await client.chat.completions
    .create({
      model: 'google/gemini-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } },
          ],
        },
      ],
    })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.message).toContain('Could not fetch a URL');
  expect(upstream.requests).toHaveLength(0);
});
