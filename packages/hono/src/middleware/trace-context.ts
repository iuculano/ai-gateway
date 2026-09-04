import { randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

// W3C Trace Context traceparent: version-traceid-parentid-flags.
// https://www.w3.org/TR/trace-context/
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/** W3C identifiers established for one gateway request. */
export interface RequestTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

// Make the trace identifiers visible on every Context: c.var.traceId and
// c.var.spanId are typed everywhere. They are undefined on routes that
// traceContext() does not cover.
declare module 'hono' {
  interface ContextVariableMap {
    traceId: string;
    spanId: string;
    parentSpanId: string | undefined;
  }
}

/**
 * Middleware that establishes W3C Trace Context for the request.
 *
 * Continues the trace from a valid incoming `traceparent` header (the norm
 * behind Front Door / API Management / any instrumented upstream), or starts
 * a new trace otherwise. A fresh span id is always generated - this service
 * is its own hop.
 *
 * The ids are what joins this request's log records to distributed traces
 * (App Insights' operation_Id is the trace id). When a real OTel SDK is
 * introduced, this middleware is the seam to replace with span creation.
 *
 * @returns
 * An async middleware function.
 */
export function traceContext() {
  return createMiddleware(async (c: Context, next: Next) => {
    const match = c.req.header('traceparent')?.match(TRACEPARENT_PATTERN);
    const incomingVersion = match?.[1];
    const incomingTraceId = match?.[2];
    const incomingSpanId = match?.[3];

    let traceId = randomBytes(16).toString('hex');
    let parentSpanId: string | undefined;

    // An all-zero trace or parent id is invalid per spec - start fresh.
    if (
      incomingVersion !== 'ff' &&
      incomingTraceId &&
      incomingTraceId !== ZERO_TRACE_ID &&
      incomingSpanId &&
      incomingSpanId !== ZERO_SPAN_ID
    ) {
      traceId = incomingTraceId;
      parentSpanId = incomingSpanId;
    }

    c.set('traceId', traceId);
    c.set('spanId', randomBytes(8).toString('hex'));
    c.set('parentSpanId', parentSpanId);

    // A caller without an OTel propagator can still correlate this response
    // with the canonical gateway log. Setting it before next() also keeps the
    // handle on validation, authentication, and provider error responses.
    c.header('ai-trace-id', traceId);

    await next();
  });
}
