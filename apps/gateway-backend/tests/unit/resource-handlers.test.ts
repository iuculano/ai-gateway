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
      'models:write',
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
  database.script(rows());

  expect((await request(`/audit-logs/${AUDIT_ID}`)).status).toBe(404);
});

test('guardrail handlers map GUARDRAIL_NOT_FOUND to 404', async () => {
  database.script(rows());
  expect((await request(`/guardrails/${GUARDRAIL_ID}`)).status).toBe(404);

  database.script(rows());
  expect((await patch(`/guardrails/regex/${GUARDRAIL_ID}`, { name: 'renamed' })).status).toBe(404);

  database.script(rows());
  expect((await request(`/guardrails/${GUARDRAIL_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('GET /logs/:id maps LOG_NOT_FOUND to 404', async () => {
  database.script(rows());

  expect((await request(`/logs/${LOG_ID}`)).status).toBe(404);
});

test('DELETE /logs/:id maps LOG_NOT_FOUND to 404', async () => {
  database.script(rows());

  expect((await request(`/logs/${LOG_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('static collection routes are not swallowed by parameter routes', async () => {
  database.script(
    rows({ total: 0 }),
    rows({
      complete: 0,
      failed: 0,
      incomplete: 0,
      input_tokens: 0,
      output_tokens: 0,
      input_cost: 0,
      output_cost: 0,
    }),
  );
  expect((await request('/logs/stats')).status).toBe(200);

  database.script(rows());
  expect((await request('/webhooks/outbox')).status).toBe(200);

  database.script(rows());
  expect((await request('/webhooks/deliveries')).status).toBe(200);

  database.script(rows());
  expect((await post('/guardrails/evaluate', { request: 'safe' })).status).toBe(200);
});

test('log payload handlers preserve the reason for each 404', async () => {
  database.script(rows());
  const missingLog = await request(`/logs/${LOG_ID}/request`);
  expect(missingLog.status).toBe(404);
  expect(await message(missingLog)).toBe('An error occurred');

  database.script(rows(logRow({ request_object_reference: null })));
  const notStored = await request(`/logs/${LOG_ID}/request`);
  expect(notStored.status).toBe(404);
  expect(await message(notStored)).toBe('No request payload was stored for this log');

  database.script(rows(logRow({ response_object_reference: 'missing-response' })));
  const unavailable = await request(`/logs/${LOG_ID}/response`);
  expect(unavailable.status).toBe(404);
  expect(await message(unavailable)).toBe('The response payload for this log is no longer available');
});

test('model handlers map MODEL_NOT_FOUND to 404', async () => {
  database.script(rows());
  expect((await request(`/models/${MODEL_ID}`)).status).toBe(404);

  database.script(rows());
  expect((await patch(`/models/${MODEL_ID}`, { name: 'renamed' })).status).toBe(404);

  database.script(rows());
  expect((await request(`/models/${MODEL_ID}`, { method: 'DELETE' })).status).toBe(404);
});

test('webhook handlers map WEBHOOK_NOT_FOUND to 404', async () => {
  database.script(rows());
  expect((await request(`/webhooks/${WEBHOOK_ID}`)).status).toBe(404);

  database.script(rows());
  expect((await patch(`/webhooks/${WEBHOOK_ID}`, { name: 'renamed' })).status).toBe(404);

  database.script(rows());
  expect((await request(`/webhooks/${WEBHOOK_ID}`, { method: 'DELETE' })).status).toBe(404);
});
