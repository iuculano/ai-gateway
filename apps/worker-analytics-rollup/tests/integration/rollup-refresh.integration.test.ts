import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { tickAnalyticsRollup } from '../../src/worker/rollup-refresh';
import { admin, prepareSuite, resetDatabase } from './setup';

let organizationId: string;
let oldHour: Date;
let currentHour: Date;

interface RollupRow {
  status: string;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  input_cost: string;
  output_cost: string;
  latency_sum: string;
  latency_count: string;
  latency_min: number | null;
  latency_max: number | null;
}

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();

  const [organization] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values ('rollup-test', 'test-idp', 'Rollup Test', 'rollup-test')
    returning id
  `;
  const [clock] = await admin`
    select
      date_trunc('hour', now()) - interval '2 hours' as old_hour,
      date_trunc('hour', now()) as current_hour
  `;

  if (!organization || !clock) {
    throw new Error('Failed to seed the analytics rollup test');
  }

  organizationId = organization.id;
  oldHour = clock.old_hour;
  currentHour = clock.current_hour;
});

afterAll(async () => {
  await resetDatabase();
  await admin.close();
});

async function seedLog(entry: {
  status: 'complete' | 'failed' | 'incomplete';
  createdAt: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputCost?: number;
  outputCost?: number;
  latency?: number | null;
}) {
  await admin`
    insert into logs (
      organization_id, model, provider, status, actor_type, actor_id,
      input_tokens, output_tokens, input_cost, output_cost, response_time_ms, created_at
    ) values (
      ${organizationId}, 'gpt-test', 'openai', ${entry.status}, 'user', ${organizationId},
      ${entry.inputTokens ?? null}, ${entry.outputTokens ?? null},
      ${entry.inputCost ?? 0}, ${entry.outputCost ?? 0}, ${entry.latency ?? null}, ${entry.createdAt}
    )
  `;
}

test('aggregates sealed hours while excluding the hour still in progress', async () => {
  await seedLog({
    status: 'complete',
    createdAt: new Date(oldHour.getTime() + 1_000),
    inputTokens: 10,
    outputTokens: 4,
    inputCost: 0.1,
    outputCost: 0.2,
    latency: 100,
  });
  await seedLog({
    status: 'complete',
    createdAt: new Date(oldHour.getTime() + 2_000),
    inputTokens: 5,
    outputTokens: 3,
    inputCost: 0.05,
    outputCost: 0.15,
    latency: 300,
  });
  await seedLog({ status: 'incomplete', createdAt: new Date(oldHour.getTime() + 3_000) });
  await seedLog({
    status: 'complete',
    createdAt: new Date(currentHour.getTime() + 1_000),
    inputTokens: 1_000,
    outputTokens: 1_000,
    latency: 999,
  });

  const result = await tickAnalyticsRollup();
  const rolledUp = (await admin`
    select * from analytics_hourly where organization_id = ${organizationId} order by status
  `) as unknown as RollupRow[];

  expect(result.status).toBe('written');
  expect(result.rows).toBe(2);
  expect(rolledUp).toHaveLength(2);

  const complete = rolledUp.find((row) => row.status === 'complete');
  const incomplete = rolledUp.find((row) => row.status === 'incomplete');

  expect(complete).toMatchObject({
    requests: '2',
    input_tokens: '15',
    output_tokens: '7',
    latency_sum: '400',
    latency_count: '2',
    latency_min: 100,
    latency_max: 300,
  });
  expect(Number(complete?.input_cost)).toBeCloseTo(0.15);
  expect(Number(complete?.output_cost)).toBeCloseTo(0.35);
  expect(incomplete).toMatchObject({
    requests: '1',
    input_tokens: '0',
    output_tokens: '0',
    latency_sum: '0',
    latency_count: '0',
    latency_min: null,
    latency_max: null,
  });
});

test('a later refresh replaces stale groups instead of leaving them behind', async () => {
  await seedLog({ status: 'failed', createdAt: new Date(oldHour.getTime() + 1_000), latency: 50 });

  await tickAnalyticsRollup();
  const before = (await admin`
    select status from analytics_hourly where organization_id = ${organizationId}
  `) as unknown as { status: string }[];
  expect(before).toEqual([{ status: 'failed' }]);

  await admin`
    update logs set status = 'complete' where organization_id = ${organizationId} and status = 'failed'
  `;
  await tickAnalyticsRollup();

  const after = (await admin`
    select status from analytics_hourly where organization_id = ${organizationId}
  `) as unknown as { status: string }[];
  expect(after).toEqual([{ status: 'complete' }]);
});
