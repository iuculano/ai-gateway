import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import type { CreateTraceRequest } from '../../src/api/traces/traces.schemas';
import TraceServices from '../../src/api/traces/traces.services';
import { callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

const WORKFLOW_TRACE = 'f3a8c17d4e2b49b6a5018c9209f4d811';
const EARLIER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const ROOT_SPAN = '4e2b49b6a5018c92';
const LLM_SPAN = '1c7e93a842d6b501';
const TOOL_SPAN = '5e2b49b6a5018c93';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  [acme, globex] = await Promise.all([seedTenant('trace-read-acme'), seedTenant('trace-read-globex')]);
});

type SpanFixture = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  offsetMs: number;
  durationMs: number;
  operation?: string;
};

function traceExport(traceId: string, startedAt: Date, spans: SpanFixture[]): CreateTraceRequest {
  const origin = BigInt(startedAt.getTime()) * 1_000_000n;

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'invoice-worker' } }],
        },
        scopeSpans: [
          {
            scope: { name: '@ai-sdk/otel', version: '1.0.0', attributes: [] },
            spans: spans.map((span) => {
              const start = origin + BigInt(span.offsetMs) * 1_000_000n;
              return {
                traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                name: span.name,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: (start + BigInt(span.durationMs) * 1_000_000n).toString(),
                attributes: span.operation
                  ? [{ key: 'gen_ai.operation.name', value: { stringValue: span.operation } }]
                  : [],
                events: [],
                links: [],
                status: { code: 1 },
              };
            }),
          },
        ],
      },
    ],
  };
}

function ingest(tenant: Tenant, request: CreateTraceRequest) {
  return runWithCaller(callerFor(tenant, ['traces:write']), () => TraceServices.createTrace(request));
}

function list(tenant: Tenant, query: Parameters<typeof TraceServices.listTraces>[0]) {
  return runWithCaller(callerFor(tenant, ['traces:read']), () => TraceServices.listTraces(query));
}

function read(tenant: Tenant, traceId: string) {
  return runWithCaller(callerFor(tenant, ['traces:read']), () => TraceServices.getTrace(traceId));
}

async function listEventually(tenant: Tenant, count: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const page = await list(tenant, { limit: 25 });
    if (page.data.length >= count) return page;
    await Bun.sleep(250);
  }

  throw new Error('Traces did not become queryable');
}

async function readEventually(tenant: Tenant, traceId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await read(tenant, traceId);
    if (result.isOk()) return result._unsafeUnwrap();
    await Bun.sleep(250);
  }

  throw new Error('Trace did not become queryable');
}

test('the list is ordered by trace start time and uses trace ids as cursors', async () => {
  const recentStart = new Date(Date.now() - 60_000);
  const earlierStart = new Date(recentStart.getTime() - 300_000);
  const root = (spanId: string): SpanFixture[] => [
    { spanId, name: 'workflow', offsetMs: 0, durationMs: 1_000, operation: 'invoke_agent' },
  ];

  await ingest(acme, traceExport(WORKFLOW_TRACE, recentStart, root(ROOT_SPAN)));
  await ingest(acme, traceExport(EARLIER_TRACE, earlierStart, root(LLM_SPAN)));

  const page = await listEventually(acme, 2);
  expect(page.data.map((trace) => trace.trace_id)).toEqual([WORKFLOW_TRACE, EARLIER_TRACE]);
  expect(page.meta).toEqual({ oldest_id: EARLIER_TRACE, more_data: false });

  await Promise.all([readEventually(acme, WORKFLOW_TRACE), readEventually(acme, EARLIER_TRACE)]);

  expect((await list(acme, { limit: 25, after_id: WORKFLOW_TRACE })).data.map((trace) => trace.trace_id)).toEqual([
    EARLIER_TRACE,
  ]);
});

test("another tenant's cursor returns an empty page", async () => {
  const startedAt = new Date(Date.now() - 60_000);
  await ingest(
    acme,
    traceExport(WORKFLOW_TRACE, startedAt, [{ spanId: ROOT_SPAN, name: 'acme', offsetMs: 0, durationMs: 1_000 }]),
  );
  await ingest(
    globex,
    traceExport(EARLIER_TRACE, startedAt, [{ spanId: ROOT_SPAN, name: 'globex', offsetMs: 0, durationMs: 1_000 }]),
  );

  await listEventually(acme, 1);
  const page = await list(acme, { limit: 25, after_id: EARLIER_TRACE });

  expect(page.data).toEqual([]);
  expect(page.meta).toEqual({ oldest_id: null, more_data: false });
});

test('detail returns application spans in waterfall order', async () => {
  const startedAt = new Date(Date.now() - 60_000);
  await ingest(
    acme,
    traceExport(WORKFLOW_TRACE, startedAt, [
      { spanId: ROOT_SPAN, name: 'checkout-recovery-agent', offsetMs: 0, durationMs: 12_180 },
      {
        spanId: LLM_SPAN,
        parentSpanId: ROOT_SPAN,
        name: 'chat gpt-5-mini',
        offsetMs: 180,
        durationMs: 2_240,
        operation: 'chat',
      },
      {
        spanId: TOOL_SPAN,
        parentSpanId: LLM_SPAN,
        name: 'execute_tool lookupVendor',
        offsetMs: 300,
        durationMs: 500,
        operation: 'execute_tool',
      },
    ]),
  );

  const detail = await readEventually(acme, WORKFLOW_TRACE);

  expect(detail.nodes.map((node) => [node.id, node.depth, node.kind])).toEqual([
    [ROOT_SPAN, 0, 'workflow'],
    [LLM_SPAN, 1, 'llm'],
    [TOOL_SPAN, 2, 'tool'],
  ]);
  expect(detail.trace).toMatchObject({ span_count: 3, tool_count: 1, duration_ms: 12_180 });
});

test('one tenant cannot read another tenant’s trace', async () => {
  await ingest(
    globex,
    traceExport(WORKFLOW_TRACE, new Date(Date.now() - 60_000), [
      { spanId: ROOT_SPAN, name: 'globex', offsetMs: 0, durationMs: 1_000 },
    ]),
  );

  await readEventually(globex, WORKFLOW_TRACE);

  const result = await read(acme, WORKFLOW_TRACE);

  expect(result._unsafeUnwrapErr()).toEqual({ code: 'TRACE_NOT_FOUND', traceId: WORKFLOW_TRACE });
});
