import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { requestId } from 'hono/request-id';
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

app.route('/', healthHandlers);

/**
 * Whether a tick is still running.
 *
 * setInterval doesn't wait for the previous run, so a slow sync could overlap
 * the next one.
 */
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) {
    return;
  }

  ticking = true;

  try {
    await tickModelCatalog();
  } catch (error) {
    // Log and carry on. A stale catalog isn't an outage, and the next tick
    // tries again.
    logger.error({ err: error }, 'Model catalog sync tick failed');
  } finally {
    ticking = false;
  }
}

// Log either way so a disabled worker doesn't look broken.
if (environment.WORKER_ENABLED) {
  setInterval(() => void tick(), environment.WORKER_POLL_INTERVAL_MS);

  logger.info(
    { poll_interval_ms: environment.WORKER_POLL_INTERVAL_MS, source_url: environment.CATALOG_SOURCE_URL },
    'Model catalog sync started',
  );

  // setInterval waits a full interval before its first run, so sync once now.
  void tick();
} else {
  logger.warn('Model catalog sync is disabled by WORKER_ENABLED - the catalog will not be refreshed');
}

// Safe to exit mid-sync since the upsert runs in one transaction.
const shutdown = () => process.exit(0);

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export default {
  fetch: app.fetch,
  port: environment.PORT,
};
