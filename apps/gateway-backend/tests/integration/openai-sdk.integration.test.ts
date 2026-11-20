import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { OpenAPIHono } from '@hono/zod-openapi';
import { callerContext, errorHandler, traceContext } from '@repo/hono';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import handlers from '../../src/api/chat-completions/chat-completions.handlers';
import decisionHandlers from '../../src/api/decisions/decisions.handlers';
import embeddingHandlers from '../../src/api/embeddings/embeddings.handlers';
import LogServices from '../../src/api/logs/logs.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

/**
 * The real openai client against the real chat completions handler, AI SDK and
 * OpenAI provider, with a local stand-in for OpenAI behind it. If the official
 * SDK is happy here, callers using it are.
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

/**
 * Reads a stream to its end, returning the text it carried and the error that
 * ended it, if one did.
 */
async function drain(stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
  let text = '';
  try {
    for await (const part of stream) {
      text += part.choices[0]?.delta.content ?? '';
    }
  } catch (error) {
    return { text, error };
  }

  return { text, error: null };
}

/**
 * A log's accounting, once queued writes have landed. The row is found by its
 * trace id, or is the latest one when the caller left before seeing an id.
 */
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
      ('unpriced-model', 'openai', null, null), ('or-model', 'openrouter', 1, 3),
      ('gemini-test', 'google', 1, 2)
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
  app.route('/v1', embeddingHandlers);
  app.route('/v1', decisionHandlers);

  client = clientFor();
});

test('create returns what the SDK expects, and echoes the trace id', async () => {
  upstream.respond = () => completion({ content: 'Hello there' });

  const { data, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .withResponse();

  expect(data).toMatchObject({
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello there', refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: USAGE,
  });
  expect(response.headers.get('ai-trace-id')).toMatch(/^[0-9a-f]{32}$/);
});

test('a request without ai-api-key is a 400 naming the header', async () => {
  const keyless = new OpenAI({
    apiKey: 'gateway-key-unchecked-here',
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => app.request(String(url), init),
  });

  const error = (await keyless.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }] })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.param).toBe('header.ai-api-key');
  expect(upstream.requests).toHaveLength(0);
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

  const parts: OpenAI.Chat.ChatCompletionChunk[] = [];
  let text = '';
  let finishReason: string | null = null;
  for await (const part of stream) {
    parts.push(part);
    text += part.choices[0]?.delta.content ?? '';
    finishReason = part.choices[0]?.finish_reason ?? finishReason;
  }

  expect(text).toBe('Hello');
  expect(finishReason).toBe('stop');

  // One id for the whole stream, the role announced first, and usage alone on the last frame.
  expect(new Set(parts.map((part) => part.id)).size).toBe(1);
  expect(parts.every((part) => part.object === 'chat.completion.chunk')).toBe(true);
  expect(parts[0]?.choices[0]?.delta.role).toBe('assistant');
  expect(parts.at(-1)).toMatchObject({ choices: [], usage: USAGE });
});

test('a stream carries no usage frame unless the caller asks for one', async () => {
  upstream.respond = () =>
    sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hi' }), chunk({}, 'stop', USAGE)]);

  const stream = await client.chat.completions.create({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  });

  const parts: OpenAI.Chat.ChatCompletionChunk[] = [];
  for await (const part of stream) {
    parts.push(part);
  }

  expect(parts.some((part) => part.usage)).toBe(false);
  expect(parts.every((part) => part.choices.length === 1)).toBe(true);
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

test('tool arguments cut off by max_tokens come back as the provider wrote them', async () => {
  // Not valid JSON, which is how the caller finds out the call was cut short.
  const cutOff = '{"id":"A';
  upstream.respond = (body) =>
    body.stream
      ? sse([
          chunk({ role: 'assistant', content: null }),
          chunk({
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: cutOff } }] }),
          chunk({}, 'length', USAGE),
        ])
      : completion(
          {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: cutOff } }],
          },
          'length',
        );
  const request = {
    model: 'openai/test-model',
    messages: [{ role: 'user' as const, content: 'Where is A1?' }],
    tools: [lookupOrder],
    max_tokens: 5,
  };

  const whole = await client.chat.completions.create(request);
  const streamed = await client.chat.completions.stream(request).finalChatCompletion();

  for (const result of [whole, streamed]) {
    const call = result.choices[0]?.message.tool_calls?.[0];
    expect(result.choices[0]?.finish_reason).toBe('length');
    expect(call?.type === 'function' ? call.function.arguments : null).toBe(cutOff);
  }
});

/** The lookup_order tool as the SDK's tool runner takes it, recording the ids it was asked for. */
function runnableLookupOrder(seen: string[]) {
  return {
    type: 'function' as const,
    function: {
      ...lookupOrder.function,
      parse: JSON.parse,
      function: async (args: { id: string }) => {
        seen.push(args.id);
        return { status: 'shipped', id: args.id };
      },
    },
  };
}

test('the SDK tool runner calls the tool and sends its result back', async () => {
  const replies = [
    completion(
      {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"id":"A1"}' } }],
      },
      'tool_calls',
    ),
    completion({ content: 'It ships tomorrow.' }),
  ];
  upstream.respond = () => replies.shift() ?? completion({ content: 'One request too many' });

  const seen: string[] = [];
  const final = await client.chat.completions
    .runTools({
      model: 'openai/test-model',
      messages: [{ role: 'user', content: 'Where is A1?' }],
      tools: [runnableLookupOrder(seen)],
    })
    .finalContent();

  expect(final).toBe('It ships tomorrow.');
  expect(seen).toEqual(['A1']);
  expect(upstream.requests[1]?.messages).toMatchObject([
    { role: 'user' },
    { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped","id":"A1"}' },
  ]);
});

test('the SDK tool runner assembles parallel tool calls from a stream that interleaves them', async () => {
  const replies = [
    sse([
      chunk({ role: 'assistant', content: null }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } }],
      }),
      chunk({
        tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'lookup_order', arguments: '' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"A1"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"B2"}' } }] }),
      chunk({}, 'tool_calls', USAGE),
    ]),
    sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Both shipped.' }), chunk({}, 'stop', USAGE)]),
  ];
  upstream.respond = () => replies.shift() ?? completion({ content: 'One request too many' });

  const seen: string[] = [];
  const runner = client.chat.completions.runTools({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Where are A1 and B2?' }],
    stream: true,
    stream_options: { include_usage: true },
    tools: [runnableLookupOrder(seen)],
  });

  expect(await runner.finalContent()).toBe('Both shipped.');
  expect(seen).toEqual(['A1', 'B2']);
  // Both turns, added up by the SDK from the usage frames.
  expect(await runner.totalUsage()).toMatchObject({ prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 });
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

test('a stream the provider rejects is an HTTP error, not a 200 that fails later', async () => {
  upstream.respond = () =>
    upstreamError(429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' });

  const error = (await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  // The status is what makes the SDK retry it.
  expect(error).toBeInstanceOf(OpenAI.RateLimitError);
  expect(error.code).toBe('rate_limit_exceeded');
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
  const { text, error } = await drain(stream);

  // What had arrived stays readable, and the failure is the SDK's own error type.
  expect(text).toBe('Partial');
  expect(error).toBeInstanceOf(OpenAI.APIError);
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

test('the SDK parse helper sends a strict schema and returns the parsed object', async () => {
  upstream.respond = () => completion({ content: '{"city":"Paris"}' });

  const result = await client.chat.completions.parse({
    model: 'openai/test-model',
    messages: [{ role: 'user', content: 'Capital of France?' }],
    response_format: zodResponseFormat(z.object({ city: z.string() }), 'answer'),
  });

  expect(result.choices[0]?.message.parsed).toEqual({ city: 'Paris' });
  expect(upstream.requests[0]?.response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { name: 'answer', strict: true },
  });
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

test('more than one choice is refused with a 400 naming n, not answered with one', async () => {
  const error = (await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], n: 2 })
    .catch((caught: unknown) => caught)) as InstanceType<typeof OpenAI.APIError>;

  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error.param).toBe('n');
  expect(upstream.requests).toHaveLength(0);
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
  expect((await drain(stream)).error).toBeNull();

  expect(await logRow(response.headers.get('ai-trace-id'))).toMatchObject({ input_tokens: null, input_cost: null });
});

test('accounting: a stream the provider cuts off raises in the SDK and is logged failed', async () => {
  upstream.respond = () => sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' })], false);

  const { data: stream, response } = await client.chat.completions
    .create({ model: 'openai/test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    .withResponse();
  const { text, error } = await drain(stream);

  expect(text).toBe('Hel');
  expect(error).toBeInstanceOf(OpenAI.APIError);
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

    // Both attempts fail. The point is whether the second reached the provider.
    for (const _attempt of [1, 2]) {
      const stream = await client.chat.completions.create(
        { model: 'openai/test-model', messages: [{ role: 'user', content: `cache ${name}` }], stream: true },
        options,
      );
      expect((await drain(stream)).error).toBeInstanceOf(OpenAI.APIError);
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
  expect((await drain(stream)).error).toBeNull();

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
  const { error } = await drain(stream);

  expect(error).toBeInstanceOf(OpenAI.APIError);
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

const GEMINI_USAGE = { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 };

function geminiAnswer(text: string) {
  return Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: GEMINI_USAGE,
  });
}

test('a Gemini tool call streams through the SDK helper, and its result goes back', async () => {
  // Gemini sends a call whole, with no id and no argument fragments.
  const event = {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'lookup_order', args: { id: 'A1' } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: GEMINI_USAGE,
  };
  upstream.respond = () =>
    new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

  const final = await client.chat.completions
    .stream({
      model: 'google/gemini-test',
      messages: [{ role: 'user', content: 'Where is A1?' }],
      tools: [lookupOrder],
    })
    .finalChatCompletion();

  const call = final.choices[0]?.message.tool_calls?.[0];
  expect(final.choices[0]?.finish_reason).toBe('tool_calls');
  expect(call?.type === 'function' ? JSON.parse(call.function.arguments) : null).toEqual({ id: 'A1' });

  // The id is one the gateway made up, and the tool result has to find its call by it.
  upstream.respond = () => geminiAnswer('It ships tomorrow.');
  const second = await client.chat.completions.create({
    model: 'google/gemini-test',
    messages: [
      { role: 'user', content: 'Where is A1?' },
      { role: 'assistant', content: null, tool_calls: final.choices[0]?.message.tool_calls },
      { role: 'tool', tool_call_id: call?.id ?? '', content: '{"status":"shipped"}' },
    ],
    tools: [lookupOrder],
  });

  expect(second.choices[0]?.message.content).toBe('It ships tomorrow.');
  expect(upstream.requests[1]).toMatchObject({
    contents: [
      { role: 'user' },
      { role: 'model', parts: [{ functionCall: { name: 'lookup_order', args: { id: 'A1' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'lookup_order' } }] },
    ],
  });
});

test('an OpenRouter tool call streams through the SDK helper', async () => {
  upstream.respond = () =>
    sse([
      chunk({ role: 'assistant', content: null }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":"A1"}' } }] }),
      chunk({}, 'tool_calls', USAGE),
    ]);

  const final = await client.chat.completions
    .stream({
      model: 'openrouter/or-model',
      messages: [{ role: 'user', content: 'Where is A1?' }],
      tools: [lookupOrder],
    })
    .finalChatCompletion();

  const call = final.choices[0]?.message.tool_calls?.[0];
  expect(final.choices[0]?.finish_reason).toBe('tool_calls');
  expect(call).toMatchObject({ id: 'call_1', function: { name: 'lookup_order' } });
  expect(call?.type === 'function' ? JSON.parse(call.function.arguments) : null).toEqual({ id: 'A1' });
});

// Images. Gemini can't fetch a URL itself, so the gateway downloads the image and sends it inline.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

// The SDK refuses localhost, or an address written into the URL, whatever this
// suite's setup allows. So the image servers here are reached by the machine's
// own name, which only a lookup shows to be private.
const IMAGE_HOST = hostname();

/** Asks Gemini about one image, given by URL. */
function askAboutImage(url: string) {
  return client.chat.completions.create({
    model: 'google/gemini-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
  });
}

const inlinePng = {
  contents: [{ parts: [{ text: 'What is this?' }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] }],
};

test('an image by URL is downloaded for Gemini and sent inline, redirects followed', async () => {
  const images = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch(request) {
      if (new URL(request.url).pathname === '/moved') {
        return new Response(null, { status: 302, headers: { location: '/cat' } });
      }

      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    },
  });
  upstream.respond = () => geminiAnswer('A cat.');

  try {
    const result = await askAboutImage(`http://${IMAGE_HOST}:${images.port}/moved`);
    expect(result.choices[0]?.message.content).toBe('A cat.');
  } finally {
    images.stop(true);
  }

  expect(upstream.requests[0]).toMatchObject(inlinePng);
});

test('a base64 image goes to Gemini inline, with nothing to download', async () => {
  upstream.respond = () => geminiAnswer('A cat.');

  await askAboutImage(`data:image/png;base64,${PNG_BASE64}`);

  expect(upstream.requests[0]).toMatchObject(inlinePng);
});

test('an image URL inside the gateway-s own network is a 400, and is never fetched', async () => {
  let fetched = 0;
  const internal = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch() {
      fetched++;
      return new Response('secret');
    },
  });
  const urls = ['http://169.254.169.254/latest/meta-data', `http://${IMAGE_HOST}:${internal.port}/secret`];

  // The suite's own setup allows private addresses, since the stand-in provider is local.
  delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
  try {
    for (const url of urls) {
      const error = (await askAboutImage(url).catch((caught: unknown) => caught)) as InstanceType<
        typeof OpenAI.APIError
      >;

      expect(error).toBeInstanceOf(OpenAI.BadRequestError);
      expect(error.message).toContain('Could not fetch a URL');
    }
  } finally {
    process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';
    internal.stop(true);
  }

  expect(fetched).toBe(0);
  expect(upstream.requests).toHaveLength(0);
});

test('an image over the size cap is a 400, and never reaches the provider', async () => {
  let served = 0;
  const images = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch() {
      served++;
      return new Response(new Uint8Array(21 * 1024 * 1024));
    },
  });

  try {
    const error = (await askAboutImage(`http://${IMAGE_HOST}:${images.port}/huge`).catch(
      (caught: unknown) => caught,
    )) as InstanceType<typeof OpenAI.APIError>;

    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect(error.message).toContain('Could not fetch a URL');
  } finally {
    images.stop(true);
  }

  // It was asked for, so the address was allowed and the size is what stopped it.
  expect(served).toBe(1);
  expect(upstream.requests).toHaveLength(0);
});
