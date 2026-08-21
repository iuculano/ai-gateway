import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { requestId } from 'hono/request-id';
// Middleware
import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { environment } from './environment';

import { tickModelCatalog } from './worker/catalog-sync';

export const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

app.doc31('/open-api.json', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'worker-model-catalog',
  },
});

app.get(
  '/docs',
  swaggerUI({
    url: '/open-api.json',
  }),
);

app.route('/', healthHandlers);

let shuttingDown = false;

/**
 * Whether a tick is still running.
 *
 * setInterval does not wait for the previous callback, so a sync that outlives
 * the poll interval - a slow upstream, a 4 MB body over a bad link - would have
 * the next tick start on top of it, with two passes upserting the same rows.
 */
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || shuttingDown) {
    return;
  }

  ticking = true;

  try {
    await tickModelCatalog();
  } catch (error) {
    // Nothing above this catches, and an unhandled rejection here would take
    // the process down over one unreachable upstream. A catalogue a few hours
    // stale is not an outage; the next tick tries again.
    logger.error({ err: error }, 'Model catalogue sync tick failed');
  } finally {
    ticking = false;
  }
}

// Honoured here, and said out loud - a worker that is deliberately idle should
// not look like one that is broken.
const interval = environment.WORKER_ENABLED
  ? setInterval(() => void tick(), environment.WORKER_POLL_INTERVAL_MS)
  : null;

if (environment.WORKER_ENABLED) {
  logger.info(
    { poll_interval_ms: environment.WORKER_POLL_INTERVAL_MS, source_url: environment.CATALOG_SOURCE_URL },
    'Model catalogue sync started',
  );

  // setInterval does not fire until the interval has elapsed, and at hourly
  // pacing that would leave a freshly deployed worker with nothing in the
  // catalogue for an hour. The conditional GET makes a redundant startup pass
  // cheap, so it is always worth taking one.
  void tick();
} else {
  logger.warn('Model catalogue sync is disabled by WORKER_ENABLED - the catalogue will not be refreshed');
}

const shutdown = () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (interval) {
    clearInterval(interval);
  }

  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export default {
  fetch: app.fetch,
  port: Number(environment.PORT),
};
