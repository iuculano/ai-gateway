import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import AnalyticsServices from '../../src/api/analytics/analytics.services';
import GuardrailServices from '../../src/api/guardrails/guardrails.services';
import LogServices from '../../src/api/logs/logs.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

let acme: Tenant;
let globex: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('acme');
  globex = await seedTenant('globex');
});

function asTenant<T>(tenant: Tenant, work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFor(tenant), work);
}

async function seedGuardrail(tenant: Tenant): Promise<string> {
  const config = JSON.stringify({ pattern: 'blocked' });
  const [row] = await admin`
    insert into guardrails (organization_id, name, type, target, action, config)
    values (${tenant.organizationId}, 'secret-filter', 'regex', 'request', 'block', (${config}::text)::jsonb)
    returning id
  `;

  if (!row) {
    throw new Error('Failed to seed guardrail');
  }

  return row.id;
}

async function seedLog(tenant: Tenant, model: string): Promise<string> {
  const [row] = await admin`
    insert into logs (organization_id, model, provider, status, input_tokens, output_tokens, actor_type, actor_id)
    values (${tenant.organizationId}, ${model}, 'test', 'complete', 10, 5, 'user', ${tenant.userId})
    returning id
  `;

  if (!row) {
    throw new Error('Failed to seed log');
  }

  return row.id;
}

test('guardrail reads and writes cannot cross organizations', async () => {
  const id = await seedGuardrail(acme);

  const found = await asTenant(globex, () => GuardrailServices.getGuardrail(id));
  expect(found._unsafeUnwrapErr().code).toBe('GUARDRAIL_NOT_FOUND');

  const page = await asTenant(globex, () => GuardrailServices.listGuardrails({ limit: 50 }));
  expect(page.data).toHaveLength(0);

  const evaluated = await asTenant(globex, () => GuardrailServices.evaluateGuardrails({ request: 'blocked' }));
  expect(evaluated.results).toHaveLength(0);

  const updated = await asTenant(globex, () => GuardrailServices.updateRegexGuardrail(id, { name: 'stolen' }));
  expect(updated._unsafeUnwrapErr().code).toBe('GUARDRAIL_NOT_FOUND');

  const deleted = await asTenant(globex, () => GuardrailServices.deleteGuardrail(id));
  expect(deleted._unsafeUnwrapErr().code).toBe('GUARDRAIL_NOT_FOUND');

  const [row] = await admin`select name from guardrails where id = ${id}`;
  expect(row?.name).toBe('secret-filter');
});

test('log reads, payload batches, and deletes cannot cross organizations', async () => {
  const id = await seedLog(acme, 'private-model');

  const found = await asTenant(globex, () => LogServices.getLog(id));
  expect(found._unsafeUnwrapErr().code).toBe('LOG_NOT_FOUND');

  const page = await asTenant(globex, () => LogServices.listLogs({ limit: 50 }));
  expect(page.data).toHaveLength(0);

  const batch = await asTenant(globex, () => LogServices.getLogPayloadBatch([id], 'request'));
  expect(batch.data).toEqual({});
  expect(batch.meta.missing).toEqual([id]);

  const deleted = await asTenant(globex, () => LogServices.deleteLog(id));
  expect(deleted._unsafeUnwrapErr().code).toBe('LOG_NOT_FOUND');

  const [row] = await admin`select id from logs where id = ${id}`;
  expect(row?.id).toBe(id);
});

test('log statistics and analytics are isolated', async () => {
  await seedLog(acme, 'acme-one');
  await seedLog(acme, 'acme-two');
  await seedLog(globex, 'globex-one');

  const acmeStats = await asTenant(acme, () => LogServices.getLogStats());
  const globexStats = await asTenant(globex, () => LogServices.getLogStats());
  expect(acmeStats.total).toBe(2);
  expect(globexStats.total).toBe(1);

  // Same request body, deliberately. If the organization is omitted from the
  // analytics SQL, both callers receive the combined aggregate.
  const request = { interval: 'none' as const, group_by: [] };
  const acmeAnalytics = await asTenant(acme, () => AnalyticsServices.queryAnalyticsSeries(request));
  const globexAnalytics = await asTenant(globex, () => AnalyticsServices.queryAnalyticsSeries(request));
  expect(acmeAnalytics.points[0]?.requests).toBe(2);
  expect(globexAnalytics.points[0]?.requests).toBe(1);
});
