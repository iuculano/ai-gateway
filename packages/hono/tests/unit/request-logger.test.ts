import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logger as rootLogger } from '@repo/core';
import { Hono } from 'hono';
import { errorHandler, requestLogger } from '../../index';
import { createTestLogger } from './fixtures';

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

function loggedApp(options?: Parameters<typeof requestLogger>[0]) {
  const logging = createTestLogger();
  const child = spyOn(rootLogger, 'child').mockReturnValue(
    logging.logger as unknown as ReturnType<(typeof rootLogger)['child']>,
  );
  spies.push(child);

  const app = new Hono();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('requestId', 'request-123');
    c.set('traceId', 'a'.repeat(32));
    c.set('spanId', 'b'.repeat(16));
    await next();
  });
  app.use('*', requestLogger(options));
  app.get('/healthy', (c) => c.text('ok'));
  app.get('/failure', (c) => c.text('nope', 503));
  app.get('/throws', () => {
    throw new Error('route failed');
  });
  app.get('/livez', (c) => c.text('live'));
  app.get('/quiet', (c) => c.text('quiet'));

  return { app, child, ...logging };
}

describe('requestLogger', () => {
  test('binds correlation and HTTP request fields to a child logger', async () => {
    const { app, child } = loggedApp();
    const response = await app.request('/healthy', { method: 'GET' });

    expect(response.status).toBe(200);
    expect(child).toHaveBeenCalledWith({
      request_id: 'request-123',
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      'http.request.method': 'GET',
      'url.path': '/healthy',
    });
  });

  test('logs successful responses at info with status and elapsed time', async () => {
    const { app, calls } = loggedApp();
    await app.request('/healthy');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: 'info',
      data: { 'http.response.status_code': 200 },
      message: 'Request finished',
    });
    const elapsed = (calls[0]?.data as { time_to_response_ms: number } | undefined)?.time_to_response_ms;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test('logs 5xx responses at warn rather than duplicating error-level reporting', async () => {
    const { app, calls } = loggedApp();
    await app.request('/failure');

    expect(calls[0]).toMatchObject({
      level: 'warn',
      data: { 'http.response.status_code': 503 },
    });
  });

  test('retains both exception and access records when a route throws', async () => {
    const { app, calls } = loggedApp();
    const response = await app.request('/throws');

    expect(response.status).toBe(500);
    expect(calls.map((call) => call.level)).toEqual(['error', 'warn']);
    expect(calls[1]).toMatchObject({
      data: { 'http.response.status_code': 500 },
      message: 'Request finished',
    });
  });

  test('ignores health paths by default while still attaching their child logger', async () => {
    const { app, calls, child } = loggedApp();
    await app.request('/livez');

    expect(child).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  test('custom ignored paths replace the defaults', async () => {
    const { app, calls } = loggedApp({ ignorePaths: ['/quiet'] });

    await app.request('/quiet');
    expect(calls).toHaveLength(0);

    await app.request('/livez');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe('info');
  });
});
