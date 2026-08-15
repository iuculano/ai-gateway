import { type Logger, logger } from '@repo/core';
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

// Make the request-scoped logger visible on the Hono context.
declare module 'hono' {
  interface ContextVariableMap {
    logger: Logger;
  }
}

/**
 * Paths where we ignore logging.
 */
const IGNORE_PATHS = ['/livez', '/readyz', '/metrics'];

export interface RequestLoggerOptions {
  /** Overrides which paths are excluded from the access log. */
  ignorePaths?: string[];
}

/**
 * Middleware that logs incoming HTTP requests and their responses.
 *
 * TLDR:
 * - Attaches a child logger to the context, bound with the request's
 *   correlation ids and HTTP fields (named per OTel semantic conventions).
 *
 * - Emits the access log: one line per completed request, level scaled to
 *   the response status.
 *
 * @returns
 * An async middleware function.
 */
export function requestLogger(options: RequestLoggerOptions = {}) {
  const ignoredPaths = new Set(options.ignorePaths ?? IGNORE_PATHS);

  return createMiddleware(async (c: Context, next: Next) => {
    const childLogger = logger.child({
      request_id: c.var.requestId,
      trace_id: c.var.traceId,
      span_id: c.var.spanId,
      'http.request.method': c.req.method,
      'url.path': c.req.path,
    });

    c.set('logger', childLogger);

    const isPathIgnored = ignoredPaths.has(c.req.path);
    if (isPathIgnored) {
      await next();
      return;
    }

    const start = performance.now();

    await next();

    const status = c.res.status;

    // The access log. 5xx is logged at warn here, not error - errorHandler()
    // owns the error-level record with the stack trace.
    childLogger[status >= 500 ? 'warn' : 'info'](
      {
        'http.response.status_code': status,

        // Aggregate latency belongs to the http_request_duration_seconds
        // histogram. This field exists to find the individual slow request,
        // which a histogram cannot do - it keeps no observations, only buckets.
        time_to_response_ms: Math.round((performance.now() - start) * 1000) / 1000,
      },
      'Request finished',
    );
  });
}
