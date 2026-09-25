import { beforeEach, expect, test } from 'bun:test';
import type { Caller } from '@repo/hono';
import {
  callerFixture,
  database,
  installModuleMocks,
  LOG_ID,
  logRow,
  MODEL_ID,
  resetDoubles,
  rows,
  WEBHOOK_ID,
} from './doubles';

await installModuleMocks();

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler } = await import('@repo/hono');
const { default: auditLogHandlers } = await import('../../src/api/audit-logs/audit-logs.handlers');
const { default: guardrailHandlers } = await import('../../src/api/guardrails/guardrails.handlers');
const { default: logHandlers } = await import('../../src/api/logs/logs.handlers');
const { default: modelHandlers } = await import('../../src/api/models/models.handlers');
const { default: webhookHandlers } = await import('../../src/api/webhooks/webhooks.handlers');

const AUDIT_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000a';
const GUARDRAIL_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000b';

const caller = {
  ...callerFixture,
  permissions: {
    scopes: [
      'audit-logs:read',
      'guardrails:read',
      'guardrails:write',
      'logs:read',
      'logs:write',
      'models:read',
      'webhooks:read',
      'webhooks:write',
    ],
  },
} satisfies Caller;

const log = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', async (c, next) => {
  c.set('caller', caller);
  // biome-ignore lint/suspicious/noExplicitAny: a minimal stand-in for the request-scoped Pino logger
  c.set('logger', log as any);
  await next();
});
app.use('*', callerContext());
app.route('/v1', auditLogHandlers);
app.route('/v1', guardrailHandlers);
app.route('/v1', logHandlers);
app.route('/v1', modelHandlers);
app.route('/v1', webhookHandlers);

beforeEach(() => {
  resetDoubles();
});

function request(path: string, init?: RequestInit) {
  return app.request(`/v1${path}`, init);
}

function patch(path: string, body: unknown) {
  return request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function message(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

test('GET /audit-logs/:id maps AUDIT_LOG_NOT_FOUND to 404', async () => {
  database.respondTo('select', 'audit_logs', rows());

  expect((await request(`/audit-logs/${AUDIT_ID}`)).status).toBe(404);
});

test('guardrail handlers map GUARDRAIL_NOT_FOUND to 404', async () => {
  database.respondTo('select', 'guardrails', rows());
  expect((await request(`/guardrails/${GUARDRAIL_ID}`)).status).toBe(404);

  database.respondTo('select', 'guardrails', rows());
  expect((await patch(`/guardrails/regex/${GUARDRAIL_ID}`, { name: 'renamed' })).status).toBe(404);

  database.respondTo('delete', 'guardrails', rows());
  expect((await request(`/guardrails/${GUARDRAIL_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('GET /logs/:id maps LOG_NOT_FOUND to 404', async () => {
  database.respondTo('select', 'logs', rows());

  expect((await request(`/logs/${LOG_ID}`)).status).toBe(404);
});

test('DELETE /logs/:id maps LOG_NOT_FOUND to 404', async () => {
  database.respondTo('delete', 'logs', rows());

  expect((await request(`/logs/${LOG_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('static collection routes are not swallowed by parameter routes', async () => {
  database.respondTo('execute', null, ...[0, 0, 0].map((count) => rows({ count })));
  expect((await request('/logs/count')).status).toBe(200);

  database.respondTo('select', 'webhook_outbox', rows());
  expect((await request('/webhooks/outbox')).status).toBe(200);

  database.respondTo('select', 'webhook_deliveries', rows());
  expect((await request('/webhooks/deliveries')).status).toBe(200);

  database.respondTo('select', 'guardrails', rows());
  expect((await post('/guardrails/evaluate', { request: 'safe' })).status).toBe(200);
});

test('log payload handlers preserve the reason for each 404', async () => {
  database.respondTo('select', 'logs', rows());
  const missingLog = await request(`/logs/${LOG_ID}/request`);
  expect(missingLog.status).toBe(404);
  expect(await message(missingLog)).toBe('An error occurred');

  database.respondTo('select', 'logs', rows(logRow({ request_object_reference: null })));
  const notStored = await request(`/logs/${LOG_ID}/request`);
  expect(notStored.status).toBe(404);
  expect(await message(notStored)).toBe('No request payload was stored for this log');

  database.respondTo('select', 'logs', rows(logRow({ response_object_reference: 'missing-response' })));
  const unavailable = await request(`/logs/${LOG_ID}/response`);
  expect(unavailable.status).toBe(404);
  expect(await message(unavailable)).toBe('The response payload for this log is no longer available');
});

test('model handlers map MODEL_NOT_FOUND to 404', async () => {
  database.respondTo('select', 'models', rows());
  expect((await request(`/models/${MODEL_ID}`)).status).toBe(404);

  expect((await patch(`/models/${MODEL_ID}`, { name: 'renamed' })).status).toBe(404);

  expect((await request(`/models/${MODEL_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('webhook handlers map WEBHOOK_NOT_FOUND to 404', async () => {
  database.respondTo('select', 'webhooks', rows());
  expect((await request(`/webhooks/${WEBHOOK_ID}`)).status).toBe(404);

  database.respondTo('select', 'webhooks', rows());
  expect((await patch(`/webhooks/${WEBHOOK_ID}`, { name: 'renamed' })).status).toBe(404);

  database.respondTo('delete', 'webhooks', rows());
  expect((await request(`/webhooks/${WEBHOOK_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('model catalog has no create endpoint', async () => {
  expect(
    (
      await request('/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'manual-model', provider: 'openai' }),
      })
    ).status,
  ).toBe(404);
  expect(database.queriesFor('insert', 'models')).toHaveLength(0);
});

test('provider catalog is served at /models/providers before the model ID route', async () => {
  database.respondTo('select', 'models', rows());

  const response = await app.request('/v1/models/providers');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [], meta: { oldest_id: null, more_data: false } });
  expect((await app.request('/v1/providers')).status).toBe(404);
});

test('provider pages trim the probe group and return a provider cursor', async () => {
  database.respondTo(
    'select',
    'models',
    rows({ id: 'anthropic', synced_at: null, models: [] }, { id: 'openai', synced_at: null, models: [] }),
  );
  const response = await app.request('/v1/models/providers?limit=1');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [{ id: 'anthropic', synced_at: null, models: [] }],
    meta: { oldest_id: 'anthropic', more_data: true },
  });
  expect(database.queriesFor('select', 'models')[0]?.calls.find((call) => call.method === 'limit')?.args).toEqual([2]);

  database.respondTo('select', 'models', rows({ id: 'openai', synced_at: null, models: [] }));
  const next = await app.request('/v1/models/providers?limit=1&after_id=anthropic');
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ meta: { oldest_id: 'openai', more_data: false } });
});

test.each(['0', '201', '1.5', 'abc'])('invalid provider page limit returns 400: %s', async (limit) => {
  const response = await app.request(`/v1/models/providers?limit=${limit}`);
  expect(response.status).toBe(400);
  expect(database.queriesFor('select', 'models')).toHaveLength(0);
});
