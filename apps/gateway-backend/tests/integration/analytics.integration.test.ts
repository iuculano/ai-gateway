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

function query(request: Parameters<typeof AnalyticsServices.queryAnalytics>[0] = {}) {
  return runWithCaller(callerFor(acme), () => AnalyticsServices.queryAnalytics(request));
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
      tags
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
      (${tags}::text)::jsonb
    )
  `;
}

test('an organization with no logs receives a complete zero-valued analytics response', async () => {
  const analytics = await query();

  expect(analytics).toEqual({
    total_logs: 0,
    successful_logs: 0,
    error_logs: 0,
    total_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    average_input_tokens: null,
    average_output_tokens: null,
    average_output_tokens_per_second: null,
    cost_total: 0,
    cost_input: 0,
    cost_output: 0,
    average_latency_ms: null,
    maximum_latency_ms: null,
    minimum_latency_ms: null,
    p50_latency_ms: null,
    p95_latency_ms: null,
    p99_latency_ms: null,
  });
});

test('analytics aggregates statuses, usage, cost, and filters against real PostgreSQL types', async () => {
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
  expect(all).toMatchObject({
    total_logs: 3,
    successful_logs: 1,
    error_logs: 2,
    total_tokens: 18,
    total_input_tokens: 13,
    total_output_tokens: 5,
    cost_total: 0.33,
    cost_input: 0.13,
    cost_output: 0.2,
  });

  const filtered = await query({ model: 'gpt-test', status: 'complete', tags: 'team:blue' });
  expect(filtered).toMatchObject({
    total_logs: 1,
    successful_logs: 1,
    error_logs: 0,
    total_tokens: 15,
    cost_total: 0.3,
  });
});
