import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import type { CreateTraceRequest } from '../../src/api/traces/traces.schemas';
import TraceServices from '../../src/api/traces/traces.services';
import { callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

const TRACE_ID = 'f3a8c17d4e2b49b6a5018c9209f4d811';
const ROOT_SPAN_ID = '4e2b49b6a5018c92';
const TOOL_SPAN_ID = '5e2b49b6a5018c93';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  [acme, globex] = await Promise.all([seedTenant('trace-ingest-acme'), seedTenant('trace-ingest-globex')]);
});

function traceExport(rootStatus = 1, childStatus = 1): CreateTraceRequest {
  const start = BigInt(Date.now() - 60_000) * 1_000_000n;

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'invoice-worker' } },
            { key: 'deployment.environment.name', value: { stringValue: 'test' } },
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
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: (start + 12_180_000_000n).toString(),
                attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }],
                events: [],
                links: [],
                status: { code: rootStatus },
              },
              {
                traceId: TRACE_ID,
                spanId: TOOL_SPAN_ID,
                parentSpanId: ROOT_SPAN_ID,
                name: 'execute_tool lookupVendor',
                startTimeUnixNano: (start + 1_000_000_000n).toString(),
                endTimeUnixNano: (start + 2_000_000_000n).toString(),
                attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }],
                events: [],
                links: [],
                status: { code: childStatus },
              },
            ],
          },
        ],
      },
    ],
  };
}

function ingest(tenant: Tenant, request: CreateTraceRequest) {
  return runWithCaller(callerFor(tenant, ['traces:write']), () => TraceServices.createTrace(request));
}

function read(tenant: Tenant) {
  return runWithCaller(callerFor(tenant, ['traces:read']), () => TraceServices.getTrace(TRACE_ID));
}

async function readableTrace(tenant: Tenant) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await read(tenant);
    if (result.isOk()) return result._unsafeUnwrap();
    await Bun.sleep(250);
  }

  throw new Error('Trace did not become queryable');
}

test('an OTLP export is queryable through the trace detail service', async () => {
  expect(await ingest(acme, traceExport())).toEqual({});

  const detail = await readableTrace(acme);

  expect(detail.trace).toMatchObject({
    trace_id: TRACE_ID,
    name: 'checkout-recovery-agent',
    status: 'complete',
    span_count: 2,
    tool_count: 1,
    error_count: 0,
  });
  expect(detail.nodes.map((node) => node.id)).toEqual([ROOT_SPAN_ID, TOOL_SPAN_ID]);
});

test('retries do not duplicate spans in the read model', async () => {
  const request = traceExport();
  await ingest(acme, request);
  await ingest(acme, request);

  const detail = await readableTrace(acme);

  expect(detail.trace.span_count).toBe(2);
  expect(detail.nodes).toHaveLength(2);
});

test('the same trace id is isolated by the derived Victoria tenant', async () => {
  await Promise.all([ingest(acme, traceExport()), ingest(globex, traceExport(2))]);

  const [acmeTrace, globexTrace] = await Promise.all([readableTrace(acme), readableTrace(globex)]);

  expect(acmeTrace.trace.status).toBe('complete');
  expect(globexTrace.trace.status).toBe('failed');
});

test('a failed child is counted without marking a successful root failed', async () => {
  await ingest(acme, traceExport(1, 2));

  const detail = await readableTrace(acme);

  expect(detail.trace).toMatchObject({ status: 'complete', error_count: 1 });
});
