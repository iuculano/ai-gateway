import { beforeEach, expect, mock, test } from 'bun:test';
import type { Caller } from '@repo/hono';
import {
  apiKeyRow,
  auditWrites,
  database,
  failsWith,
  installModuleMocks,
  KEY_ID,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';

await installModuleMocks();

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/api-keys/api-keys.handlers');

const log = {
  error: mock(() => {}),
  warn: mock(() => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
};

const userActor = {
  type: 'user',
  user: { id: USER_ID, username: 'alex', email: 'alex@example.com' },
} satisfies Caller['actor'];

const apiKeyActor = {
  type: 'api_key',
  key: { id: KEY_ID, name: 'ci' },
  owner: userActor.user,
} satisfies Caller['actor'];

const caller: Caller = {
  organization: { id: ORGANIZATION_ID, name: 'acme' },
  actor: userActor,
  permissions: { scopes: ['api-keys:read', 'api-keys:write'] },
  request: {},
};

/**
 * The app without its authentication chain.
 *
 * The caller is planted directly, because what is under test here is what the
 * handlers answer with - authenticate() has its own reasons to reject and none
 * of them come from these services.
 */
const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', async (c, next) => {
  c.set('caller', caller);
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the request-scoped pino logger
  c.set('logger', log as any);

  await next();
});
app.use('*', callerContext());
app.route('/v1', handlers);

function request(path: string, init?: RequestInit) {
  return app.request(`/v1${path}`, init);
}

function patch(body: unknown, id: string = KEY_ID) {
  return request(`/api-keys/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(body: unknown) {
  return request('/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetDoubles();
  caller.actor = userActor;
  log.error.mockClear();
  log.warn.mockClear();
  log.info.mockClear();
  log.debug.mockClear();
});

test('GET /api-keys/:id answers 200', async () => {
  database.respondTo('select', 'api_keys', rows(apiKeyRow()));

  const response = await request(`/api-keys/${KEY_ID}`);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: KEY_ID, name: 'ci' });
});

test('GET /api-keys/:id answers 404 for a key that is not there', async () => {
  database.respondTo('select', 'api_keys', rows());

  const response = await request(`/api-keys/${KEY_ID}`);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: { code: 404, status: 'Not Found', message: 'An error occurred' },
  });
});

test('GET /api-keys/:id/stats answers 404 for a key that is not there', async () => {
  database.respondTo('select', 'api_keys', rows());

  expect((await request(`/api-keys/${KEY_ID}/stats`)).status).toBe(404);
});

test('GET /api-keys answers 200', async () => {
  database.respondTo('select', 'api_keys', rows(apiKeyRow()));

  const response = await request('/api-keys');

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ meta: { more_data: false } });
});

test('an API key caller may still read API keys', async () => {
  caller.actor = apiKeyActor;
  database.respondTo('select', 'api_keys', rows(apiKeyRow()));

  expect((await request(`/api-keys/${KEY_ID}`)).status).toBe(200);
});

const apiKeyManagementRequests = [
  ['create', () => post({ name: 'replacement' })],
  ['update', () => patch({ rate_limit_requests: null })],
  ['revoke', () => request(`/api-keys/${KEY_ID}`, { method: 'DELETE' })],
] as const;

for (const [operation, makeRequest] of apiKeyManagementRequests) {
  test(`an API key caller cannot ${operation} API keys even when it holds api-keys:write`, async () => {
    caller.actor = apiKeyActor;

    const response = await makeRequest();

    expect(response.status).toBe(403);
    expect(database.queries).toHaveLength(0);
  });
}

test('POST /api-keys answers 201 with the plaintext key', async () => {
  database.respondTo('insert', 'api_keys', rows(apiKeyRow()));

  const response = await post({ name: 'ci' });

  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: KEY_ID });
});

test('POST /api-keys answers 403 for scopes the caller does not hold', async () => {
  const response = await post({ name: 'ci', scopes: 'admin:everything' });

  expect(response.status).toBe(403);
  expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="admin:everything"');
});

test('PATCH /api-keys/:id answers 200', async () => {
  database.respondTo('select', 'api_keys', rows(apiKeyRow()));
  database.respondTo('update', 'api_keys', rows(apiKeyRow({ name: 'renamed' })));

  const response = await patch({ name: 'renamed' });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'renamed' });
});

test('PATCH /api-keys/:id answers 404 for a key that is not there', async () => {
  database.respondTo('select', 'api_keys', rows());

  expect((await patch({ name: 'renamed' })).status).toBe(404);
});

test('PATCH /api-keys/:id answers 409 for a revoked key', async () => {
  database.respondTo('select', 'api_keys', rows(apiKeyRow({ revoked_at: new Date('2026-02-01T00:00:00.000Z') })));

  const response = await patch({ name: 'renamed' });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: 409, status: 'Conflict', message: 'Cannot update a revoked API key' },
  });
});

test('PATCH /api-keys/:id answers 403 for scopes the caller does not hold', async () => {
  const response = await patch({ scopes: 'admin:everything' });

  expect(response.status).toBe(403);
  expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="admin:everything"');
});

test('PATCH /api-keys/:id answers 400 when a request limit would have no window', async () => {
  database.respondTo('select', 'api_keys', rows(apiKeyRow()));

  const response = await patch({ rate_limit_requests: 10 });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: 'rate_limit_window is required when rate_limit_requests is set' },
  });
});

test('DELETE /api-keys/:id answers an empty 204', async () => {
  database.respondTo('update', 'api_keys', rows(apiKeyRow({ revoked_at: new Date(), revoked_by: USER_ID })));

  const response = await request(`/api-keys/${KEY_ID}`, { method: 'DELETE' });

  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
});

test('DELETE /api-keys/:id answers 204 again for an already revoked key', async () => {
  database.respondTo('update', 'api_keys', rows());
  database.respondTo('select', 'api_keys', rows({ id: KEY_ID }));

  expect((await request(`/api-keys/${KEY_ID}`, { method: 'DELETE' })).status).toBe(204);
  expect(auditWrites.calls).toHaveLength(0);
});

test('DELETE /api-keys/:id answers 404 for a key that is not there', async () => {
  database.respondTo('update', 'api_keys', rows());
  database.respondTo('select', 'api_keys', rows());

  expect((await request(`/api-keys/${KEY_ID}`, { method: 'DELETE' })).status).toBe(404);
});

// The unexpected channel

test('a rejected service promise reaches the global handler as a sanitized 500', async () => {
  database.respondTo('select', 'api_keys', failsWith(new Error('connection terminated')));

  const response = await request(`/api-keys/${KEY_ID}`);

  expect(response.status).toBe(500);

  // The cause does not travel to the caller.
  const body = await response.text();
  expect(body).not.toContain('connection terminated');
  expect(JSON.parse(body)).toMatchObject({
    error: { code: 500, status: 'Internal Server Error', message: 'An unexpected error occurred' },
  });
});

test('an unexpected failure is logged as an error', async () => {
  database.respondTo('select', 'api_keys', failsWith(new Error('connection terminated')));

  await request(`/api-keys/${KEY_ID}`);

  expect(log.error).toHaveBeenCalled();
});

// The generated document

test('every status the handlers answer with is documented', () => {
  // Throwing an HTTPException at runtime puts nothing in the OpenAPI document,
  // so the route declarations have to be kept honest by hand - which is what
  // this asserts. Read off the generated document rather than the route
  // objects, because the document is what clients are generated from.
  const document = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { version: '1.0.0', title: 'gateway-api' },
  });

  // biome-ignore lint/suspicious/noExplicitAny: the generator's own types are not the subject here
  const paths = document.paths as any;

  const documented = (path: string, method: string) => Object.keys(paths[path]?.[method]?.responses ?? {}).sort();

  expect(documented('/v1/api-keys/{id}', 'get')).toEqual(['200', '400', '401', '403', '404', '429', '500']);
  expect(documented('/v1/api-keys/{id}/stats', 'get')).toEqual(['200', '400', '401', '403', '404', '429', '500']);
  expect(documented('/v1/api-keys', 'get')).toEqual(['200', '400', '401', '403', '429', '500']);
  expect(documented('/v1/api-keys', 'post')).toEqual(['201', '400', '401', '403', '429', '500']);
  expect(documented('/v1/api-keys/{id}', 'patch')).toEqual(['200', '400', '401', '403', '404', '409', '429', '500']);
  expect(documented('/v1/api-keys/{id}', 'delete')).toEqual(['204', '400', '401', '403', '404', '429', '500']);
});

test('an expected refusal is logged as a warning, not an error', async () => {
  database.respondTo('select', 'api_keys', rows());

  await request(`/api-keys/${KEY_ID}`);

  expect(log.warn).toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
});
