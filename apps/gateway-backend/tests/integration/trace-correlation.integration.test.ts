import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import LogServices from '../../src/api/logs/logs.services';
import { callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  [acme, globex] = await Promise.all([seedTenant('trace-acme'), seedTenant('trace-globex')]);
});

function openCorrelatedLog(tenant: Tenant, spanId: string): Promise<string> {
  return runWithCaller(
    callerFor(tenant),
    () =>
      LogServices.startLog(tenant.organizationId, {
        model: 'integration-model',
        provider: 'test-provider',
        actor_type: 'user',
        actor_id: tenant.userId,
      }),
    {
      trace: {
        traceId: TRACE_ID,
        spanId,
        parentSpanId: PARENT_SPAN_ID,
      },
    },
  );
}

test('one W3C trace groups distinct gateway spans without crossing tenants', async () => {
  const firstSpanId = '1111111111111111';
  const secondSpanId = '2222222222222222';
  const foreignSpanId = '3333333333333333';

  const [firstId, secondId, foreignId] = await Promise.all([
    openCorrelatedLog(acme, firstSpanId),
    openCorrelatedLog(acme, secondSpanId),
    openCorrelatedLog(globex, foreignSpanId),
  ]);

  const acmePage = await runWithCaller(callerFor(acme), () => LogServices.listLogs({ limit: 10, trace_id: TRACE_ID }));
  const globexPage = await runWithCaller(callerFor(globex), () =>
    LogServices.listLogs({ limit: 10, trace_id: TRACE_ID }),
  );

  expect(new Set(acmePage.data.map((row) => row.id))).toEqual(new Set([firstId, secondId]));
  expect(acmePage.data.map((row) => row.trace_id)).toEqual([TRACE_ID, TRACE_ID]);
  expect(new Set(acmePage.data.map((row) => row.span_id))).toEqual(new Set([firstSpanId, secondSpanId]));
  expect(acmePage.data.map((row) => row.parent_span_id)).toEqual([PARENT_SPAN_ID, PARENT_SPAN_ID]);

  expect(globexPage.data).toHaveLength(1);
  expect(globexPage.data[0]).toMatchObject({ id: foreignId, trace_id: TRACE_ID, span_id: foreignSpanId });
});

test('database constraints reject invalid W3C identifiers at the persistence boundary', async () => {
  await expect(openCorrelatedLog(acme, '0'.repeat(16))).rejects.toThrow();
});
