import { describe, expect, test } from 'bun:test';
import type { JWTAuthAdapter, KeyAuthAdapter } from '@repo/hono/auth-adapter';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { authenticate, errorHandler } from '../../index';
import { apiKeyIdentity, createTestLogger, userIdentity } from './fixtures';

interface AdapterCalls {
  jwt: Parameters<JWTAuthAdapter>[0][];
  key: Parameters<KeyAuthAdapter>[0][];
}

const bunEnvironment = {
  server: {
    requestIP: () => ({ address: '192.0.2.10', family: 'IPv4', port: 43123 }),
  },
};

function request(app: Hono, authorization?: string, userAgent?: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/',
      {
        headers: {
          ...(authorization && { Authorization: authorization }),
          ...(userAgent && { 'User-Agent': userAgent }),
        },
      },
      bunEnvironment,
    ),
  );
}

function authenticatedApp(options: { keyAdapter?: KeyAuthAdapter } = {}) {
  const calls: AdapterCalls = { jwt: [], key: [] };
  const jwtAdapter: JWTAuthAdapter = async (input) => {
    calls.jwt.push(input);
    return userIdentity;
  };
  const keyAdapter: KeyAuthAdapter =
    options.keyAdapter ??
    (async (input) => {
      calls.key.push(input);
      return apiKeyIdentity;
    });
  const { logger } = createTestLogger();
  const app = new Hono();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('logger', logger);
    await next();
  });
  app.use('*', requestId({ generator: () => 'request-from-middleware' }));
  app.use('*', authenticate({ jwtAdapter, keyAdapter }));
  app.get('/', (c) => c.json(c.var.caller));

  return { app, calls };
}

describe('authenticate', () => {
  test('routes compact JWT credentials to the JWT adapter and attaches transport context', async () => {
    const { app, calls } = authenticatedApp();
    const response = await request(app, 'Bearer header.payload.signature', 'hono-test');

    expect(response.status).toBe(200);
    expect(calls.key).toHaveLength(0);
    expect(calls.jwt).toEqual([
      {
        token: 'header.payload.signature',
        request: {
          id: 'request-from-middleware',
          ipAddress: '192.0.2.10',
          userAgent: 'hono-test',
        },
      },
    ]);
    expect(await response.json()).toMatchObject({
      actor: { type: 'user' },
      request: { id: 'request-from-middleware', userAgent: 'hono-test' },
    });
  });

  test('routes non-JWT bearer credentials to the key adapter', async () => {
    const { app, calls } = authenticatedApp();
    const response = await request(app, 'bearer aik_secret');

    expect(response.status).toBe(200);
    expect(calls.jwt).toHaveLength(0);
    expect(calls.key[0]?.key).toBe('aik_secret');
    expect(await response.json()).toMatchObject({ actor: { type: 'api_key' } });
  });

  test('rejects missing, malformed, and ambiguous authorization headers before adapters run', async () => {
    const { app, calls } = authenticatedApp();

    for (const authorization of [undefined, '', 'Basic secret', 'Bearer', 'Bearer one two', 'Bearer\tone']) {
      const response = await request(app, authorization);
      expect(response.status).toBe(401);
    }

    expect(calls.jwt).toHaveLength(0);
    expect(calls.key).toHaveLength(0);
  });

  test('allows the RFC-required run of spaces between Bearer and its credential', async () => {
    const { app, calls } = authenticatedApp();
    const response = await request(app, 'Bearer   aik_secret');

    expect(response.status).toBe(200);
    expect(calls.key[0]?.key).toBe('aik_secret');
  });

  test('rejects API keys when no key adapter is configured', async () => {
    const app = new Hono();
    const { logger } = createTestLogger();
    app.onError(errorHandler());
    app.use('*', async (c, next) => {
      c.set('logger', logger);
      await next();
    });
    app.use('*', authenticate({ jwtAdapter: async () => userIdentity }));
    app.get('/', (c) => c.text('unreachable'));

    const response = await request(app, 'Bearer aik_secret');

    expect(response.status).toBe(401);
  });
});
