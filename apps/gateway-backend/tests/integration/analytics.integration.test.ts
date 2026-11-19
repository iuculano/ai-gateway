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
  gatewayCacheHit?: boolean;
  cachedInputTokens?: number;
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
        gateway_cache_hit: entry.gatewayCacheHit ?? false,
        cached_input_tokens: entry.cachedInputTokens ?? 0,
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
        gateway_cache_hits: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_input: 0,
        cost_output: 0,
        cost_total: 0,
        average_latency_ms: null,
        minimum_latency_ms: null,
        maximum_latency_ms: null,
        median_latency_ms: null,
        p95_latency_ms: null,
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
    // The null latency stays out of the percentiles too.
    median_latency_ms: 100,
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

test('tokens count only what a provider processed: gateway cache hits are left out', async () => {
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, inputTokens: 10, outputTokens: 5 });
  // Answered from the gateway's cache: logged with the original usage, at no cost.
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputTokens: 10,
    outputTokens: 5,
    inputCost: 0,
    outputCost: 0,
    gatewayCacheHit: true,
  });

  const [totals] = (await query()).points;

  expect(totals).toMatchObject({
    requests: 2,
    gateway_cache_hits: 1,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  });
});

function tokens(request: Partial<Parameters<typeof AnalyticsServices.queryAnalyticsTokens>[0]> = {}, tenant = acme) {
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsTokens(request));
}

test('token medians are per request a provider answered, untouched by one huge request', async () => {
  for (const [input, output] of [
    [100, 10],
    [200, 20],
    [300, 30],
    [50_000, 4_000],
  ] as const) {
    await seedLog({
      model: 'm',
      provider: 'openai',
      status: 'complete',
      ...usage,
      inputTokens: input,
      outputTokens: output,
    });
  }
  // A gateway cache hit, made huge so it would drag the median if counted.
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputTokens: 90_000,
    outputTokens: 9_000,
    gatewayCacheHit: true,
  });
  // Failed requests carry no usage, and an abandoned one only a cut-off answer.
  // Counted, they'd pull the median down to 100.
  for (const status of ['failed', 'failed'] as const) {
    await seedLog({ model: 'm', provider: 'openai', status, ...usage, inputTokens: 0, outputTokens: 0 });
  }
  await seedLog({ model: 'm', provider: 'openai', status: 'incomplete', ...usage, inputTokens: 5, outputTokens: 1 });

  const result = await tokens();

  // Four answered requests: the median sits between 200 and 300, not near the outlier.
  expect(result.median_input_tokens).toBeGreaterThanOrEqual(200);
  expect(result.median_input_tokens).toBeLessThanOrEqual(300);
  expect(result.median_output_tokens).toBeGreaterThanOrEqual(20);
  expect(result.median_output_tokens).toBeLessThanOrEqual(30);
  expect(result.p95_input_tokens).toBeLessThanOrEqual(50_000);
  // Totals leave the cache hit out too, but keep the abandoned request's tokens
  // because the provider used them. Requests and bands count answers only.
  expect(result).toMatchObject({ requests: 4, input_tokens: 50_605, output_tokens: 4_061 });
  expect(result.input_bands.map((band) => band.requests)).toEqual([3, 0, 0, 1, 0]);
  expect(result.output_bands.map((band) => band.requests)).toEqual([3, 0, 0, 1, 0]);
  expect(result.input_bands[3]).toEqual({ min: 16_000, max: 64_000, requests: 1 });
  expect(result.input_bands.at(-1)).toEqual({ min: 64_000, max: null, requests: 0 });

  // Another tenant's requests are never counted.
  expect((await tokens({}, globex)).median_input_tokens).toBeNull();
});

test('token medians: with no logs, nothing is measured and every band is empty', async () => {
  const result = await tokens();
  expect(result).toMatchObject({
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    median_input_tokens: null,
    p95_input_tokens: null,
    median_output_tokens: null,
    p95_output_tokens: null,
  });
  expect(result.input_bands.every((band) => band.requests === 0)).toBe(true);
  expect(result.output_bands).toHaveLength(5);
});

test('tokens: input served from the provider prompt cache is counted', async () => {
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputTokens: 1_000,
    cachedInputTokens: 600,
  });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, inputTokens: 1_000 });

  expect(await tokens()).toMatchObject({ input_tokens: 2_000, cached_input_tokens: 600 });
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

function users(request: Partial<Parameters<typeof AnalyticsServices.queryAnalyticsUsers>[0]> = {}, tenant = acme) {
  const body = { limit: 50, offset: 0, sort: 'spend' as const, ...request };
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsUsers(body));
}

function sessions(
  request: Partial<Parameters<typeof AnalyticsServices.queryAnalyticsSessions>[0]> = {},
  tenant = acme,
) {
  const body = { limit: 10, offset: 0, sort: 'spend' as const, ...request };
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsSessions(body));
}

function sessionDistribution(
  request: Partial<Parameters<typeof AnalyticsServices.queryAnalyticsSessionDistribution>[0]> = {},
  tenant = acme,
) {
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsSessionDistribution(request));
}

function sessionPositions(
  request: Partial<Parameters<typeof AnalyticsServices.queryAnalyticsSessionPositions>[0]> = {},
  tenant = acme,
) {
  return runWithCaller(callerFor(tenant), () => AnalyticsServices.queryAnalyticsSessionPositions(request));
}

test('users: how many, and a page of them biggest spend first', async () => {
  const spend = (cost: number) => ({ ...usage, inputCost: cost, outputCost: 0 });
  // u-1 spends 3 over two requests, u-2 spends 1, and one log has no user.
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(1), tags: { user_id: 'u-1' } });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(2), tags: { user_id: 'u-1' } });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(1), tags: { user_id: 'u-2' } });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(5) });

  const result = await users();
  expect(result.active_users).toBe(2);
  expect(result.users).toEqual([
    { user_id: 'u-1', requests: 2, tokens: 4, cost_total: 3 },
    { user_id: 'u-2', requests: 1, tokens: 2, cost_total: 1 },
  ]);
  // u-2's 1 at the bottom, u-1's 3 at the top; the untagged 5 isn't a user's.
  expect(result.cost_percentiles).toHaveLength(99);
  expect(result.cost_percentiles[0]).toBeCloseTo(1, 1);
  expect(result.cost_percentiles[98]).toBeCloseTo(3, 1);

  // Pages follow on without overlapping, and still see every user.
  const second = await users({ limit: 1, offset: 1 });
  expect(second.active_users).toBe(2);
  expect(second.cost_percentiles).toEqual(result.cost_percentiles);
  expect(second.users).toEqual([{ user_id: 'u-2', requests: 1, tokens: 2, cost_total: 1 }]);

  // Another tenant's users are never counted.
  expect((await users({}, globex)).active_users).toBe(0);
});

test('users: with no logs, the count is zero and the rest empty', async () => {
  expect(await users()).toEqual({ active_users: 0, cost_percentiles: [], users: [] });
});

test('users: narrowing to one API key counts only that app', async () => {
  const keyId = generateActorId('api_key');
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    actorId: keyId,
    tags: { user_id: 'u-1' },
  });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, tags: { user_id: 'u-2' } });

  const oneApp = await users({ actor_id: keyId });
  expect(oneApp.active_users).toBe(1);
  expect(oneApp.users.map((user) => user.user_id)).toEqual(['u-1']);
});

test('sessions: count and the most expensive, for everyone or one user', async () => {
  const spend = (cost: number) => ({ ...usage, inputCost: cost, outputCost: 0 });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...spend(1),
    tags: { user_id: 'u-1', session_id: 's-1' },
  });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...spend(2),
    tags: { user_id: 'u-1', session_id: 's-1' },
  });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...spend(1),
    tags: { user_id: 'u-2', session_id: 's-2' },
  });
  // Not in a session: never listed or counted.
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(9), tags: { user_id: 'u-2' } });

  const all = await sessions();
  expect(all.count).toBe(2);
  expect(all.top).toEqual([
    { session_id: 's-1', user_id: 'u-1', users: 1, requests: 2, tokens: 4, cost_total: 3, seconds: 0 },
    { session_id: 's-2', user_id: 'u-2', users: 1, requests: 1, tokens: 2, cost_total: 1, seconds: 0 },
  ]);

  // Limited to one, it still counts both.
  const first = await sessions({ limit: 1 });
  expect(first.top.map((row) => row.session_id)).toEqual(['s-1']);
  expect(first.count).toBe(2);
  const oneUser = await sessions({ user_id: 'u-2' });
  expect(oneUser.count).toBe(1);
  expect(oneUser.top.map((row) => row.session_id)).toEqual(['s-2']);
});

test('sessions: a shared session stays one row with its whole cost, naming no one user', async () => {
  const spend = (cost: number) => ({ ...usage, inputCost: cost, outputCost: 0 });
  // u-1 and u-2 in one chat, plus a request in it that names no user.
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...spend(1),
    tags: { user_id: 'u-1', session_id: 's-1' },
  });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...spend(2),
    tags: { user_id: 'u-2', session_id: 's-1' },
  });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(4), tags: { session_id: 's-1' } });

  const all = await sessions();
  expect(all.count).toBe(1);
  expect(all.top).toEqual([
    { session_id: 's-1', user_id: '', users: 2, requests: 3, tokens: 6, cost_total: 7, seconds: 0 },
  ]);

  // Narrowed to one user, it's their part of the session.
  expect((await sessions({ user_id: 'u-2' })).top).toEqual([
    { session_id: 's-1', user_id: 'u-2', users: 1, requests: 1, tokens: 2, cost_total: 2, seconds: 0 },
  ]);
});

test('sessions: ordered by requests or length, paged, or narrowed to one', async () => {
  // s-1 spends most in one request, s-2 takes three requests over a minute, and
  // s-3 takes two, an hour apart.
  const at = (time: string) => `2026-10-28 ${time}.000`;
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputCost: 5,
    tags: { session_id: 's-1' },
  });
  for (const time of ['10:00:00', '10:00:30', '10:01:00']) {
    await seedLog({
      model: 'm',
      provider: 'openai',
      status: 'complete',
      ...usage,
      createdAt: at(time),
      tags: { session_id: 's-2' },
    });
  }
  for (const time of ['09:00:00', '10:00:00']) {
    await seedLog({
      model: 'm',
      provider: 'openai',
      status: 'complete',
      ...usage,
      createdAt: at(time),
      tags: { session_id: 's-3' },
    });
  }

  const order = async (sort: 'spend' | 'requests' | 'length') =>
    (await sessions({ sort })).top.map((row) => [row.session_id, row.seconds]);
  expect(await order('spend')).toEqual([
    ['s-1', 0],
    ['s-2', 60],
    ['s-3', 3600],
  ]);
  expect(await order('requests')).toEqual([
    ['s-2', 60],
    ['s-3', 3600],
    ['s-1', 0],
  ]);
  expect(await order('length')).toEqual([
    ['s-3', 3600],
    ['s-2', 60],
    ['s-1', 0],
  ]);

  // The second page picks up where the first stopped, and counts everything.
  const page = await sessions({ sort: 'length', limit: 1, offset: 1 });
  expect(page.top.map((row) => row.session_id)).toEqual(['s-2']);
  expect(page.count).toBe(3);

  // Looked up by id, a session comes back on its own.
  const one = await sessions({ session_id: 's-3' });
  expect(one.count).toBe(1);
  expect(one.top).toMatchObject([{ session_id: 's-3', requests: 2, seconds: 3600 }]);
});

test('session distribution: percentiles and bands across sessions, untagged logs left out', async () => {
  const spend = (cost: number) => ({ ...usage, inputCost: cost, outputCost: 0 });
  // Three single-request sessions under a cent, one of 20 cents over 6
  // requests, and one of $15. Plus an untagged request that mustn't count.
  for (const id of ['a', 'b', 'c']) {
    await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(0.005), tags: { session_id: id } });
  }
  for (let i = 0; i < 6; i++) {
    await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(0.2 / 6), tags: { session_id: 'd' } });
  }
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(15), tags: { session_id: 'e' } });
  await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...spend(99) });

  const result = await sessionDistribution();

  expect(result.sessions).toBe(5);
  expect(result.cost_percentiles).toHaveLength(99);
  expect(result.request_percentiles[49]).toBe(1); // the median session is one request
  expect(result.cost_bands.map((band) => band.sessions)).toEqual([3, 0, 1, 0, 1]);
  expect(result.cost_bands[0]?.cost_total).toBeCloseTo(0.015);
  expect(result.cost_bands[2]?.cost_total).toBeCloseTo(0.2);
  expect(result.cost_bands.at(-1)).toEqual({ min: 10, max: null, sessions: 1, cost_total: 15 });
  expect(result.request_bands).toEqual([
    { min: 1, max: 1, sessions: 4 },
    { min: 2, max: 5, sessions: 0 },
    { min: 6, max: 10, sessions: 1 },
    { min: 11, max: 20, sessions: 0 },
    { min: 21, max: null, sessions: 0 },
  ]);
});

test('session distribution: with no sessions, nothing to place', async () => {
  const result = await sessionDistribution();
  expect(result).toMatchObject({ sessions: 0, cost_percentiles: [], request_percentiles: [], seconds_percentiles: [] });
  expect(result.cost_bands.every((band) => band.sessions === 0)).toBe(true);
});

test('session positions: the nth request of every session, in time order, or of one', async () => {
  const at = (time: string) => `2026-10-28 ${time}.000`;
  // s-1's requests are seeded out of order, and position follows when they were made.
  for (const [time, cost, input] of [
    ['10:00:02', 3, 300],
    ['10:00:00', 1, 100],
    ['10:00:01', 2, 200],
  ] as const) {
    await seedLog({
      model: 'm',
      provider: 'openai',
      status: 'complete',
      ...usage,
      inputCost: cost,
      outputCost: 0,
      inputTokens: input,
      createdAt: at(time),
      tags: { session_id: 's-1' },
    });
  }
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputCost: 10,
    outputCost: 0,
    inputTokens: 1000,
    tags: { session_id: 's-2' },
  });

  expect((await sessionPositions()).positions).toEqual([
    { position: 1, requests: 2, sessions: 2, cost_total: 11, input_tokens: 1100 },
    { position: 2, requests: 1, sessions: 1, cost_total: 2, input_tokens: 200 },
    { position: 3, requests: 1, sessions: 1, cost_total: 3, input_tokens: 300 },
  ]);
  expect((await sessionPositions({ session_id: 's-1' })).positions.map((row) => row.cost_total)).toEqual([1, 2, 3]);
});

test('sessions: with no logs, the count is zero', async () => {
  expect(await sessions()).toEqual({ count: 0, top: [] });
  expect(await sessionPositions()).toEqual({ positions: [] });
});

test('users: the list can be ordered by tokens or requests instead of spend', async () => {
  // u-1 spends most; u-2 uses the most tokens; u-3 makes the most requests.
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputCost: 5,
    tags: { user_id: 'u-1' },
  });
  await seedLog({
    model: 'm',
    provider: 'openai',
    status: 'complete',
    ...usage,
    inputTokens: 900,
    tags: { user_id: 'u-2' },
  });
  for (let i = 0; i < 3; i++) {
    await seedLog({ model: 'm', provider: 'openai', status: 'complete', ...usage, tags: { user_id: 'u-3' } });
  }

  const order = async (sort: 'spend' | 'tokens' | 'requests') =>
    (await users({ sort })).users.map((user) => user.user_id);
  expect(await order('spend')).toEqual(['u-1', 'u-3', 'u-2']);
  expect(await order('tokens')).toEqual(['u-2', 'u-3', 'u-1']);
  expect(await order('requests')).toEqual(['u-3', 'u-1', 'u-2']);
});
