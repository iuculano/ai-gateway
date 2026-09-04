import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Caller } from '@repo/hono';
import type { CreateTraceRequest } from '../../src/api/traces/traces.schemas';
import { database, installModuleMocks, ORGANIZATION_ID, resetDoubles, rows } from './doubles';

await installModuleMocks();

const VICTORIA_TRACES_URL = 'http://victoria-traces.test';

mock.module('../../src/environment', () => ({
  environment: { VICTORIA_TRACES_URL },
}));

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler, runWithCaller } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/traces/traces.handlers');
const { default: TraceServices } = await import('../../src/api/traces/traces.services');

const TRACE_ID = 'f3a8c17d4e2b49b6a5018c9209f4d811';
const ROOT_SPAN_ID = '4e2b49b6a5018c92';
const TOOL_SPAN_ID = '5e2b49b6a5018c93';
const originalFetch = globalThis.fetch;

const caller: Caller = {
  organization: { id: ORGANIZATION_ID, name: 'acme' },
  actor: {
    type: 'api_key',
    key: {
      id: '01912d3f-9b4a-7c3d-8e2f-000000000002',
      name: 'invoice-worker',
    },
    owner: {
      id: '01912d3f-9b4a-7c3d-8e2f-000000000003',
      username: 'alex',
      email: 'alex@example.com',
    },
  },
  permissions: { scopes: ['traces:read', 'traces:write'] },
  request: {},
};

const app = new OpenAPIHono();
app.onError(errorHandler());
app.use('*', async (c, next) => {
  c.set('caller', caller);
  await next();
});
app.use('*', callerContext());
app.route('/v1', handlers);

function stubFetch(handler: (request: Request) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return handler(request);
  }) as typeof fetch;
}

function expectedTenant() {
  const digest = createHash('sha256').update(ORGANIZATION_ID).digest();
  return {
    accountId: String(digest.readUInt32BE(0)),
    projectId: String(digest.readUInt32BE(4)),
  };
}

function traceExport(): CreateTraceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'invoice-worker' } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: '@ai-sdk/otel', version: '1.0.0', attributes: [] },
            spans: [
              {
                traceId: TRACE_ID,
                spanId: ROOT_SPAN_ID,
                name: 'checkout-recovery-agent',
                kind: 1,
                startTimeUnixNano: '1788270422000000000',
                endTimeUnixNano: '1788270434180000000',
                attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }],
                events: [],
                links: [],
                status: { code: 1 },
              },
              {
                traceId: TRACE_ID,
                spanId: TOOL_SPAN_ID,
                parentSpanId: ROOT_SPAN_ID,
                name: 'execute_tool lookupVendor',
                kind: 1,
                startTimeUnixNano: '1788270423000000000',
                endTimeUnixNano: '1788270424000000000',
                attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }],
                events: [],
                links: [],
                status: { code: 2 },
              },
            ],
          },
        ],
      },
    ],
  };
}

function victoriaTrace() {
  return [
    {
      trace_id: TRACE_ID,
      span_id: TOOL_SPAN_ID,
      parent_span_id: ROOT_SPAN_ID,
      name: 'execute_tool lookupVendor',
      start_time_unix_nano: '1788270423000000000',
      end_time_unix_nano: '1788270424000000000',
      status_code: '2',
      scope_name: '@ai-sdk/otel',
      scope_version: '1.0.0',
      'resource_attr:service.name': 'invoice-worker',
      'span_attr:gen_ai.operation.name': 'execute_tool',
      'span_attr:request.body': 'must-not-reach-the-api',
    },
    {
      trace_id: TRACE_ID,
      span_id: ROOT_SPAN_ID,
      name: 'checkout-recovery-agent',
      start_time_unix_nano: '1788270422000000000',
      end_time_unix_nano: '1788270434180000000',
      status_code: '1',
      scope_name: '@ai-sdk/otel',
      scope_version: '1.0.0',
      'resource_attr:service.name': 'invoice-worker',
      'resource_attr:deployment.environment.name': 'production',
      'span_attr:gen_ai.operation.name': 'invoke_agent',
    },
  ]
    .map((span) => JSON.stringify(span))
    .join('\n');
}

function logRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '01991000-0000-7000-8000-000000000020',
    organization_id: ORGANIZATION_ID,
    model: 'gpt-5-mini',
    provider: 'openai',
    trace_id: TRACE_ID,
    span_id: '36b8a2e419f70c55',
    parent_span_id: ROOT_SPAN_ID,
    status: 'complete',
    actor_type: 'api_key',
    actor_id: '01912d3f-9b4a-7c3d-8e2f-000000000002',
    input_tokens: 1_480,
    output_tokens: 312,
    input_cost: '0.001800000000',
    output_cost: '0.001000000000',
    response_time_ms: 2_058,
    request_object_reference: null,
    response_object_reference: null,
    tags: { environment: 'production' },
    created_at: new Date('2026-09-01T13:47:02.236Z'),
    updated_at: new Date('2026-09-01T13:47:04.294Z'),
    ...overrides,
  };
}

/**
 * Where the request went, split into the parts worth asserting on.
 *
 * The origin is whatever VICTORIA_TRACES_URL is configured to, which differs
 * between a bare checkout and the devcontainer - where it has to be
 * host.docker.internal for the backend to reach the container at all. Pinning
 * the whole URL made these tests pass only on a machine where the variable was
 * unset. What actually matters is that the request goes to the configured
 * server, at the right path, carrying the right query.
 */
function outboundParts(request: Request | undefined) {
  const url = new URL(request?.url ?? '');

  return { origin: url.origin, pathname: url.pathname, search: url.search };
}

const VICTORIA_ORIGIN = new URL(VICTORIA_TRACES_URL).origin;

beforeEach(() => {
  resetDoubles();
  caller.permissions = { scopes: ['traces:read', 'traces:write'] };
  stubFetch(() => {
    throw new Error('Unexpected VictoriaTraces request');
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('createTrace posts OTLP JSON with server-derived tenant headers', async () => {
  let outbound: Request | undefined;
  stubFetch((request) => {
    outbound = request;
    return new Response(null, { status: 204 });
  });

  const result = await runWithCaller(caller, () => TraceServices.createTrace(traceExport()));
  const tenant = expectedTenant();

  expect(result).toEqual({});
  expect(outboundParts(outbound)).toEqual({
    origin: VICTORIA_ORIGIN,
    pathname: '/insert/opentelemetry/v1/traces',
    search: '',
  });
  expect(outbound?.method).toBe('POST');
  expect(outbound?.headers.get('accountid')).toBe(tenant.accountId);
  expect(outbound?.headers.get('projectid')).toBe(tenant.projectId);
  expect(outbound?.headers.get('content-type')).toBe('application/json');
  expect(await outbound?.json()).toEqual(traceExport());
});

test('listTraces applies the same tenant to reads without accepting tenant input', async () => {
  let outbound: Request | undefined;
  stubFetch((request) => {
    outbound = request;
    return new Response('');
  });

  await runWithCaller(caller, () => TraceServices.listTraces({ limit: 25 }));

  const tenant = expectedTenant();
  expect(outboundParts(outbound)).toEqual({
    origin: VICTORIA_ORIGIN,
    pathname: '/select/logsql/query',
    search: expect.stringContaining('?query='),
  });
  expect(outbound?.headers.get('accountid')).toBe(tenant.accountId);
  expect(outbound?.headers.get('projectid')).toBe(tenant.projectId);
});

test('POST /traces skips an empty export and pushes a populated export', async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return new Response(null, { status: 204 });
  });

  const empty = await app.request('/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  const populated = await app.request('/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(traceExport()),
  });

  expect(empty.status).toBe(200);
  expect(populated.status).toBe(200);
  expect(calls).toBe(1);
  expect(database.queries).toHaveLength(0);
});

test('createTrace rejects a VictoriaTraces ingestion error', async () => {
  stubFetch(() => new Response('request exceeds the limit', { status: 413 }));

  await expect(runWithCaller(caller, () => TraceServices.createTrace(traceExport()))).rejects.toThrow(
    'VictoriaTraces push failed with HTTP 413',
  );
});

test('GET /traces maps one LogsQL summary and adds trusted log totals', async () => {
  const requests: Request[] = [];
  stubFetch((request) => {
    requests.push(request);
    return new Response(
      JSON.stringify({
        trace_id: TRACE_ID,
        started_at: '1788270422000000000',
        ended_at: '1788270434180000000',
        span_count: '2',
        tool_count: '1',
        error_count: '1',
        root_count: '1',
        open_count: '0',
        name: 'checkout-recovery-agent',
        root_status: '1',
        service_name: 'invoice-worker',
        environment: 'production',
      }),
    );
  });
  database.respondTo(
    'select',
    'logs',
    rows({
      trace_id: TRACE_ID,
      log_count: 2,
      input_tokens: '4900',
      output_tokens: '714',
      cost: '0.014200000000',
      failed_log_count: 1,
    }),
  );

  const response = await app.request('/v1/traces?limit=25');
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toContain('/select/logsql/query?query=');
  expect(decodeURIComponent(new URL(requests[0]?.url ?? '').searchParams.get('query') ?? '')).toContain(
    'stats by (trace_id)',
  );
  expect(body.data[0]).toMatchObject({
    id: TRACE_ID,
    trace_id: TRACE_ID,
    name: 'checkout-recovery-agent',
    status: 'complete',
    duration_ms: 12_180,
    span_count: 2,
    tool_count: 1,
    error_count: 2,
    log_count: 2,
    total_input_tokens: 4_900,
    total_output_tokens: 714,
    total_cost: 0.0142,
    tags: { service: 'invoice-worker', environment: 'production' },
  });
  expect(body.meta).toEqual({ oldest_id: TRACE_ID, more_data: false });
});

test('GET /traces skips PostgreSQL when VictoriaTraces returns no summaries', async () => {
  stubFetch(() => new Response(''));

  const response = await app.request('/v1/traces');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [],
    meta: { oldest_id: null, more_data: false },
  });
  expect(database.queries).toHaveLength(0);
});

test('GET /traces/:trace_id builds a tenant-scoped waterfall and hides arbitrary span attributes', async () => {
  stubFetch(() => new Response(victoriaTrace()));
  database.respondTo('select', 'logs', rows(logRow()));

  const response = await app.request(`/v1/traces/${TRACE_ID}`);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.nodes.map((node: { id: string; depth: number }) => [node.id, node.depth])).toEqual([
    [ROOT_SPAN_ID, 0],
    ['36b8a2e419f70c55', 1],
    [TOOL_SPAN_ID, 1],
  ]);
  expect(body.nodes[0]).toMatchObject({
    source: 'application_span',
    kind: 'workflow',
    status: 'ok',
    duration_ms: 12_180,
    attributes: { service: 'invoice-worker', scope: '@ai-sdk/otel' },
  });
  expect(body.nodes[2]).toMatchObject({ kind: 'tool', status: 'error' });
  expect(body.nodes[2].attributes).not.toHaveProperty('request.body');
  expect(body.trace).toMatchObject({
    id: TRACE_ID,
    trace_id: TRACE_ID,
    status: 'complete',
    detail_status: 'complete',
    window_ms: 12_180,
    span_count: 2,
    tool_count: 1,
    error_count: 1,
    total_input_tokens: 1_480,
    total_output_tokens: 312,
    total_cost: 0.0028,
  });
});

test('GET /traces/:trace_id returns 404 without querying logs when the tenant cannot see the trace', async () => {
  stubFetch(() => new Response(''));

  const response = await app.request(`/v1/traces/${TRACE_ID}`);

  expect(response.status).toBe(404);
  expect(database.queries).toHaveLength(0);
});

test('trace authorization and validation happen before VictoriaTraces is called', async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return new Response(null, { status: 204 });
  });
  caller.permissions = { scopes: [] };

  const forbidden = await app.request('/v1/traces');
  caller.permissions = { scopes: ['traces:read'] };
  const malformed = await app.request('/v1/traces/not-a-trace-id');

  expect(forbidden.status).toBe(403);
  expect(malformed.status).toBe(400);
  expect(calls).toBe(0);
});
