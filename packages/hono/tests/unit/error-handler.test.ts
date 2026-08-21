import { describe, expect, test } from 'bun:test';
import { z } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorHandler, zodExceptionHook } from '../../src/middleware/error-handler';
import { createTestLogger } from './fixtures';

function errorApp(throwError: () => never) {
  const app = new Hono();
  const logging = createTestLogger();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('logger', logging.logger);
    await next();
  });
  app.get('/', () => throwError());
  return { app, ...logging };
}

describe('errorHandler', () => {
  test('formats expected HTTP errors and logs client failures as warnings', async () => {
    const { app, calls } = errorApp(() => {
      throw new HTTPException(404, { message: 'Widget not found' });
    });

    const response = await app.request('/');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 404, status: 'Not Found', message: 'Widget not found' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: 'warn',
      data: { 'http.response.status_code': 404 },
      message: 'Widget not found',
    });
  });

  test('preserves operational headers carried by an HTTPException response', async () => {
    const { app } = errorApp(() => {
      throw new HTTPException(429, {
        message: 'Slow down',
        res: new Response('ignored', {
          headers: {
            'Content-Type': 'text/plain',
            'Retry-After': '12',
            RateLimit: 'limit=5, remaining=0, reset=12',
          },
        }),
      });
    });

    const response = await app.request('/');

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(response.headers.get('RateLimit')).toBe('limit=5, remaining=0, reset=12');
    expect(response.headers.get('Content-Type')).toStartWith('application/json');
  });

  test('formats Zod issues with their validation target and full path', async () => {
    const schema = z.object({ profile: z.object({ age: z.number().int().positive() }) });
    const result = schema.safeParse({ profile: { age: -1 } });
    if (result.success) {
      throw new Error('Fixture must fail validation');
    }

    const { app } = errorApp(() => {
      zodExceptionHook({ target: 'json', ...result });
      throw new Error('zodExceptionHook did not throw');
    });
    const response = await app.request('/');
    const body = (await response.json()) as {
      error: { details: Array<{ field: string; issue: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      {
        field: 'json.profile.age',
        issue: 'Too small: expected number to be >0',
      },
    ]);
  });

  test('logs intentional server errors at error level', async () => {
    const { app, calls } = errorApp(() => {
      throw new HTTPException(503, { message: 'Temporarily unavailable' });
    });

    const response = await app.request('/');

    expect(response.status).toBe(503);
    expect(calls[0]?.level).toBe('error');
  });

  test('labels a 401 with the RFC 6750 invalid_token challenge', async () => {
    const { app } = errorApp(() => {
      throw new HTTPException(401, { message: 'Token rejected' });
    });

    const response = await app.request('/');

    // Fifteen call sites throw a 401 and none of them set this. A BFF renewing
    // tokens needs it to tell a token problem, which a refresh fixes, from any
    // other reason a 401 might surface, which it does not.
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
  });

  test('does not overwrite a more specific challenge already on the exception', async () => {
    const { app } = errorApp(() => {
      throw new HTTPException(401, {
        res: new Response(null, {
          headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="logs:read"' },
        }),
      });
    });

    const response = await app.request('/');

    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="logs:read"');
  });

  test('leaves non-401 responses unchallenged', async () => {
    const { app } = errorApp(() => {
      throw new HTTPException(403, { message: 'Forbidden' });
    });

    const response = await app.request('/');

    expect(response.headers.has('WWW-Authenticate')).toBe(false);
  });

  test('sanitizes unexpected exceptions while retaining the original error in logs', async () => {
    const failure = new Error('database password leaked here');
    const { app, calls } = errorApp(() => {
      throw failure;
    });

    const response = await app.request('/');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 500, status: 'Internal Server Error', message: 'An unexpected error occurred' },
    });
    expect(calls[0]).toMatchObject({
      level: 'error',
      data: { err: failure, 'http.response.status_code': 500 },
      message: 'Unhandled exception',
    });
  });
});

test('zodExceptionHook is a no-op for successful validation', () => {
  expect(zodExceptionHook({ target: 'query', success: true, data: { healthy: true } })).toBeUndefined();
});
