import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { clickhouse } from '@repo/clickhouse';
import { generateActorId } from '@repo/core';
import { runWithCaller } from '@repo/hono';
import type { AnalyticsDimension } from '../../src/api/analytics/analytics.schemas';
import AnalyticsServices from '../../src/api/analytics/analytics.services';
import { callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('analytics');
  globex = await seedTenant('other');
});

afterEach(resetDatabase);

type SeriesRequest = Parameters<typeof AnalyticsServices.queryAnalyticsSeries>[0];

function analytics(request: Partial<SeriesRequest> = {}, tenant = acme) {
  const body: SeriesRequest = { interval: 'day', groupings: [[]], ...request };
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsSeries(body));
}

/** One grouping's points; most tests only need one. */
async function query(request: Partial<SeriesRequest> & { group_by?: AnalyticsDimension[] } = {}, tenant = acme) {
  const { group_by = [], ...rest } = request;
  const result = await analytics({ ...rest, groupings: [group_by] }, tenant);
  return { points: result.groupings[0]?.points ?? [] };
}

/** Analytics reads ClickHouse, which the worker's sync fills; tests seed it directly. */
async function seedLog(entry: {
  model: string;
  provider: string;
  status: 'complete' | 'failed' | 'incomplete';
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  responseTimeMs: number | null;
  createdAt?: string;
  actorId?: string;
  tags?: Record<string, string>;
  tenant?: Tenant;
}) {
  const tenant = entry.tenant ?? acme;
  await clickhouse.insert({
    table: 'logs',
    format: 'JSONEachRow',
    values: [
      {
        id: crypto.randomUUID(),
        organization_id: tenant.organizationId,
        created_at: entry.createdAt ?? '2026-10-28 10:15:00.000',
        updated_at: '2026-10-28 10:16:00.000000',
        operation: 'chat',
        model: entry.model,
        provider: entry.provider,
        status: entry.status,
        // Every row names who spent. The tenant's own user stands in for the caller.
        actor_id: entry.actorId ?? tenant.userId,
        tags: entry.tags ?? {},
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        input_cost: entry.inputCost,
        output_cost: entry.outputCost,
        response_time_ms: entry.responseTimeMs,
      },
    ],
  });
}

const usage = { inputTokens: 1, outputTokens: 1, inputCost: 0.01, outputCost: 0.01, responseTimeMs: 50 };

test('an organization with no logs receives a zero-valued analytics series', async () => {
  const analytics = await query();

  expect(analytics).toEqual({
    points: [
      {
        bucket: null,
        model: null,
        provider: null,
        status: null,
        actor_type: null,
        actor_id: null,
        user_id: null,
        session_id: null,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_input: 0,
        cost_output: 0,
        cost_total: 0,
        average_latency_ms: null,
        minimum_latency_ms: null,
        maximum_latency_ms: null,
      },
    ],
  });
});

test('analytics series aggregates usage and cost and filters against real ClickHouse types', async () => {
  await seedLog({
    model: 'gpt-test',
    provider: 'openai',
    status: 'complete',
    inputTokens: 10,
    outputTokens: 5,
    inputCost: 0.1,
    outputCost: 0.2,
    responseTimeMs: 100,
  });
  await seedLog({
    model: 'gpt-test',
    provider: 'openai',
    status: 'failed',
    inputTokens: 3,
    outputTokens: 0,
    inputCost: 0.03,
    outputCost: 0,
    responseTimeMs: 200,
  });
  await seedLog({
    model: 'other-model',
    provider: 'azure',
    status: 'incomplete',
    inputTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    responseTimeMs: 0,
  });
  // No latency recorded: counted as a request, left out of the latency average.
  await seedLog({
    model: 'other-model',
    provider: 'azure',
    status: 'failed',
    inputTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    responseTimeMs: null,
  });

  const all = await query();
  expect(all.points[0]).toMatchObject({
    requests: 4,
    total_tokens: 18,
    input_tokens: 13,
    output_tokens: 5,
    cost_input: 0.13,
    cost_output: 0.2,
    average_latency_ms: 100,
    minimum_latency_ms: 0,
    maximum_latency_ms: 200,
  });
  expect(all.points[0]?.cost_total).toBeCloseTo(0.33);

  const filtered = await query({ model: 'gpt-test', status: 'complete' });
  expect(filtered.points[0]).toMatchObject({ requests: 1, total_tokens: 15, input_tokens: 10, output_tokens: 5 });
  expect(filtered.points[0]?.cost_total).toBeCloseTo(0.3);
});

test("one organization never sees another's logs", async () => {
  await seedLog({ model: 'gpt-test', provider: 'openai', status: 'complete', ...usage });
  await seedLog({ model: 'gpt-test', provider: 'openai', status: 'complete', ...usage, tenant: globex });
  await seedLog({ model: 'gpt-test', provider: 'openai', status: 'complete', ...usage, tenant: globex });

  expect((await query()).points[0]?.requests).toBe(1);
  expect((await query({}, globex)).points[0]?.requests).toBe(2);
});

test('hourly buckets come back in order, and dates bound the range', async () => {
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, createdAt: '2026-10-28 09:59:59.000' });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, createdAt: '2026-10-28 10:00:00.000' });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, createdAt: '2026-10-28 10:30:00.000' });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, createdAt: '2026-10-28 12:00:00.000' });

  const series = await query({
    interval: 'hour',
    group_by: ['bucket'],
    start_date: new Date('2026-10-28T09:00:00Z'),
    end_date: new Date('2026-10-28T12:00:00Z'),
  });

  expect(series.points.map((point) => [point.bucket?.toISOString(), point.requests])).toEqual([
    ['2026-10-28T09:00:00.000Z', 1],
    ['2026-10-28T10:00:00.000Z', 2],
  ]);
});

test('an actor breakdown ranks callers by volume', async () => {
  const keyId = generateActorId('api_key');
  for (let i = 0; i < 3; i++) {
    await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, actorId: keyId });
  }
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage });

  const breakdown = await query({ group_by: ['actor'] });

  expect(breakdown.points.map((point) => [point.actor_type, point.actor_id, point.requests])).toEqual([
    ['api_key', keyId, 3],
    ['user', acme.userId, 1],
  ]);
});

test('one request answers several groupings, in the order asked, each matching its own query', async () => {
  await seedLog({ model: 'a', provider: 'openai', status: 'complete', ...usage, createdAt: '2026-10-28 09:10:00.000' });
  await seedLog({ model: 'a', provider: 'openai', status: 'failed', ...usage, createdAt: '2026-10-28 10:10:00.000' });
  await seedLog({ model: 'b', provider: 'azure', status: 'complete', ...usage, createdAt: '2026-10-28 10:20:00.000' });

  const groupings: AnalyticsDimension[][] = [['status'], [], ['bucket', 'provider'], ['provider', 'model'], ['status']];
  const combined = await analytics({ interval: 'hour', groupings });

  expect(combined.groupings.map((grouping) => grouping.group_by)).toEqual(groupings);
  for (const [index, group_by] of groupings.entries()) {
    const alone = await query({ interval: 'hour', group_by });
    expect(combined.groupings[index]?.points).toEqual(alone.points);
  }

  expect(combined.groupings[1]?.points.map((point) => point.requests)).toEqual([3]);
  expect(combined.groupings[0]?.points.map((point) => [point.status, point.requests])).toEqual([
    ['complete', 2],
    ['failed', 1],
  ]);
});

test('with no logs, the totals are a zero row and every other grouping is empty', async () => {
  const result = await analytics({ groupings: [[], ['model'], ['bucket']] });

  expect(result.groupings.map((grouping) => grouping.points.map((point) => point.requests))).toEqual([[0], [], []]);
});

test('a grouping written in a different order is the same grouping, not counted twice', async () => {
  await seedLog({ model: 'a', provider: 'openai', status: 'complete', ...usage });
  await seedLog({ model: 'b', provider: 'azure', status: 'complete', ...usage });

  const result = await analytics({
    groupings: [
      ['model', 'provider'],
      ['provider', 'model'],
    ],
  });

  expect(result.groupings[0]?.points.map((point) => point.requests)).toEqual([1, 1]);
  expect(result.groupings[1]?.points).toEqual(result.groupings[0]?.points);
});

test('the well-known user and session tags group and filter like any other dimension', async () => {
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    tags: { user_id: 'u-1', session_id: 's-1' },
  });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    tags: { user_id: 'u-1', session_id: 's-2' },
  });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, tags: { user_id: 'u-2' } });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage });

  const byUser = await query({ group_by: ['user'] });
  expect(byUser.points.map((point) => [point.user_id, point.requests])).toEqual([
    ['u-1', 2],
    ['', 1], // untagged
    ['u-2', 1],
  ]);

  const oneUser = await query({ group_by: ['session'], user_id: 'u-1' });
  expect(oneUser.points.map((point) => [point.session_id, point.requests])).toEqual([
    ['s-1', 1],
    ['s-2', 1],
  ]);
});
