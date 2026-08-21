import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { traceContext } from '../../src/middleware/trace-context';

function traceApp() {
  const app = new Hono();
  app.use('*', traceContext());
  app.get('/', (c) =>
    c.json({
      traceId: c.var.traceId,
      spanId: c.var.spanId,
      parentSpanId: c.var.parentSpanId,
    }),
  );
  return app;
}

describe('traceContext', () => {
  test('continues a valid W3C trace while creating a fresh local span', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const response = await traceApp().request('/', {
      headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
    });
    const body = (await response.json()) as Record<string, string>;

    expect(body.traceId).toBe(traceId);
    expect(body.parentSpanId).toBe(parentSpanId);
    expect(body.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.spanId).not.toBe(parentSpanId);
  });

  test('creates a valid new trace when no parent is supplied', async () => {
    const response = await traceApp().request('/');
    const body = (await response.json()) as Record<string, string>;

    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.traceId).not.toBe('0'.repeat(32));
    expect(body.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(body).not.toHaveProperty('parentSpanId');
  });

  test('rejects all-zero trace and span identifiers', async () => {
    const traceId = '1'.repeat(32);
    const zeroTrace = await traceApp().request('/', {
      headers: { traceparent: `00-${'0'.repeat(32)}-${'2'.repeat(16)}-01` },
    });
    const zeroSpan = await traceApp().request('/', {
      headers: { traceparent: `00-${traceId}-${'0'.repeat(16)}-01` },
    });

    expect(((await zeroTrace.json()) as Record<string, string>).parentSpanId).toBeUndefined();
    expect(((await zeroSpan.json()) as Record<string, string>).parentSpanId).toBeUndefined();
  });

  test('rejects the forbidden ff trace-context version and malformed uppercase input', async () => {
    const traceId = 'a'.repeat(32);
    const spanId = '2'.repeat(16);
    const forbidden = await traceApp().request('/', {
      headers: { traceparent: `ff-${traceId}-${spanId}-01` },
    });
    const uppercase = await traceApp().request('/', {
      headers: { traceparent: `00-${traceId.toUpperCase()}-${spanId}-01` },
    });

    expect(((await forbidden.json()) as Record<string, string>).parentSpanId).toBeUndefined();
    expect(((await uppercase.json()) as Record<string, string>).parentSpanId).toBeUndefined();
  });
});
