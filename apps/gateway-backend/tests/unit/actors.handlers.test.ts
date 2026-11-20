import { beforeEach, expect, test } from 'bun:test';
import type { Caller } from '@repo/hono';
import { database, installModuleMocks, KEY_ID, ORGANIZATION_ID, resetDoubles, rows, USER_ID } from './doubles';

await installModuleMocks();

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { callerContext, errorHandler } = await import('@repo/hono');
const { default: handlers } = await import('../../src/api/actors/actors.handlers');

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
  permissions: { scopes: ['actors:read'] },
  request: {},
};

const log = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

// The app without its authentication chain, with the caller planted directly.
const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', async (c, next) => {
  c.set('caller', caller);
  // biome-ignore lint/suspicious/noExplicitAny: a minimal stand-in for the request-scoped Pino logger
  c.set('logger', log as any);
  await next();
});
app.use('*', callerContext());
app.route('/v1/internal', handlers);

function resolve(actors: unknown) {
  return app.request('/v1/internal/actors/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actors }),
  });
}

beforeEach(() => {
  resetDoubles();
  caller.actor = userActor;
  caller.permissions = { scopes: ['actors:read'] };
});

test('POST /actors/resolve answers 200 for a user session, whatever the case of the ID', async () => {
  database.respondTo('select', 'users', rows({ id: USER_ID, name: 'Alex' }));

  const response = await resolve([{ actor_type: 'user', actor_id: USER_ID.toUpperCase() }]);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [{ actor_type: 'user', actor_id: USER_ID, display: { name: 'Alex' } }],
  });
});

test('POST /actors/resolve answers 403 for an API key, even one holding the scope', async () => {
  caller.actor = apiKeyActor;

  const response = await resolve([{ actor_type: 'user', actor_id: USER_ID }]);

  expect(response.status).toBe(403);
  expect(database.queries).toHaveLength(0);
});

test('POST /actors/resolve answers 403 without the scope', async () => {
  caller.permissions = { scopes: [] };

  const response = await resolve([{ actor_type: 'user', actor_id: USER_ID }]);

  expect(response.status).toBe(403);
  expect(database.queries).toHaveLength(0);
});
