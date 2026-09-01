import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import AnalyticsServices from '../../src/api/analytics/analytics.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

let acme: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('analytics');
});

afterEach(resetDatabase);

type SeriesRequest = Parameters<typeof AnalyticsServices.queryAnalyticsSeries>[0];

function query(request: Partial<SeriesRequest> = {}) {
  const body: SeriesRequest = {
    interval: 'none',
    group_by: [],
    ...request,
  };

  return runWithCaller(callerFor(acme), () => AnalyticsServices.queryAnalyticsSeries(body));
}

async function seedLog(entry: {
  model: string;
  provider: string;
  status: 'complete' | 'failed' | 'incomplete';
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  responseTimeMs: number;
  tags?: Record<string, string>;
}) {
  const tags = JSON.stringify(entry.tags ?? {});

  await admin`
    insert into logs (
      organization_id,
      model,
      provider,
      status,
      input_tokens,
      output_tokens,
      input_cost,
      output_cost,
      response_time_ms,
      tags,
      actor_type,
      actor_id
    ) values (
      ${acme.organizationId},
      ${entry.model},
      ${entry.provider},
      ${entry.status},
      ${entry.inputTokens},
      ${entry.outputTokens},
      ${entry.inputCost},
      ${entry.outputCost},
      ${entry.responseTimeMs},
      (${tags}::text)::jsonb,
      -- NOT NULL: every row names who spent. The tenant's own user stands in
      -- for the authenticated caller the gateway would have recorded.
      'user',
      ${acme.userId}
    )
  `;
}

test('an organization with no logs receives a zero-valued analytics series', async () => {
  const analytics = await query();

  expect(analytics).toEqual({
    interval: 'none',
    group_by: [],
    sealed_through: expect.any(String),
    points: [
      {
        bucket: null,
        model: null,
        provider: null,
        status: null,
        actor_type: null,
        actor_id: null,
        actor_label: null,
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

test('analytics series aggregates usage and cost and filters against real PostgreSQL types', async () => {
  await seedLog({
    model: 'gpt-test',
    provider: 'openai',
    status: 'complete',
    inputTokens: 10,
    outputTokens: 5,
    inputCost: 0.1,
    outputCost: 0.2,
    responseTimeMs: 100,
    tags: { team: 'blue' },
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
    tags: { team: 'red' },
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
    tags: { team: 'blue' },
  });

  const all = await query();
  expect(all.points[0]).toMatchObject({
    requests: 3,
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
  expect(filtered.points[0]).toMatchObject({
    requests: 1,
    total_tokens: 15,
    input_tokens: 10,
    output_tokens: 5,
  });
  expect(filtered.points[0]?.cost_total).toBeCloseTo(0.3);
});
