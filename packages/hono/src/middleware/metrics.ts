import { prometheus } from '@hono/prometheus';

/**
 * The prometheus registry, built on first use rather than at import time.
 */
let registry: ReturnType<typeof prometheus> | undefined;

function metrics(): ReturnType<typeof prometheus> {
  // cpu, resident memory, heap, event loop lag, gc, handles...
  registry ??= prometheus({ collectDefaultMetrics: true });

  return registry;
}

/**
 * Middleware for recording samples per request.
 *
 * Mount it ahead of anything whose time should be counted. The labels come from
 * c.req.routePath, which only resolves to the matched route after the handler
 * has run, so this has to wrap the chain rather than sit at the end of it.
 */
export const requestMetrics = () => metrics().registerMetrics;

/**
 * The /metrics endpoint prometheus scrapes.
 */
export const exposeMetrics = () => metrics().printMetrics;
