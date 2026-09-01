import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { type AuthorizeOptions, authorize, type Caller, errorHandler } from '../../index';
import { apiKeyCaller, createTestLogger, userCaller } from './fixtures';

function authorizedApp(caller: Caller | undefined, options?: AuthorizeOptions) {
  const app = new Hono();
  const { logger } = createTestLogger();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('logger', logger);
    if (caller) {
      c.set('caller', caller);
    }
    await next();
  });
  app.use('*', authorize(options));
  app.get('/', (c) => c.text('allowed'));
  return app;
}

describe('authorize', () => {
  test('requires authentication to have attached a caller', async () => {
    const response = await authorizedApp(undefined).request('/');
    expect(response.status).toBe(401);
  });

  test('allows a caller when no restrictions are configured', async () => {
    const response = await authorizedApp(userCaller).request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('allowed');
  });

  test('requires every configured scope', async () => {
    const allowed = await authorizedApp(userCaller, { scopes: ['logs:read', 'models:read'] }).request('/');
    const refused = await authorizedApp(userCaller, { scopes: ['logs:read', 'logs:write'] }).request('/');

    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="logs:read logs:write"',
    );
  });

  test('enforces actor types before checking scopes', async () => {
    const response = await authorizedApp(apiKeyCaller, {
      actorTypes: ['user'],
      scopes: ['missing:scope'],
    }).request('/');

    expect(response.status).toBe(403);
    expect(response.headers.has('WWW-Authenticate')).toBe(false);
  });

  test('allows any actor type explicitly listed', async () => {
    const response = await authorizedApp(apiKeyCaller, { actorTypes: ['user', 'api_key'] }).request('/');
    expect(response.status).toBe(200);
  });
});
