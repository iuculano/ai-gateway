import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { environment } from './environment';
import { tickWebhookProcessor } from './worker/webhook-processor';

export const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

app.doc31('/open-api.json', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'gateway-api',
  },
});

app.route('/', healthHandlers);

let shuttingDown = false;

/**
 * Whether a tick is still running.
 *
 * setInterval does not wait for the previous callback, so a drain that outlives
 * the poll interval - a slow endpoint, a large batch - used to have the next
 * tick start on top of it. SKIP LOCKED stopped them delivering the same row
 * twice, but nothing stopped them piling up.
 */
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || shuttingDown) {
    return;
  }

  ticking = true;

  try {
    await tickWebhookProcessor();
  } catch (error) {
    // Nothing above this catches, and an unhandled rejection here would take
    // the process down over one bad drain.
    logger.error({ err: error }, 'Webhook processor tick failed');
  } finally {
    ticking = false;
  }
}

// WORKER_ENABLED was previously declared and never read, so setting it to false
// still started the drain. Honoured here, and said out loud - a worker that is
// deliberately idle should not look like one that is broken.
const interval = environment.WORKER_ENABLED
  ? setInterval(() => void tick(), environment.WORKER_POLL_INTERVAL_MS)
  : null;

if (environment.WORKER_ENABLED) {
  const startupInfo = {
    poll_interval_ms: environment.WORKER_POLL_INTERVAL_MS,
    batch_size: environment.WORKER_BATCH_SIZE,
  };

  logger.info(startupInfo, 'Webhook processor started');
} else {
  logger.warn('Webhook processor is disabled by WORKER_ENABLED - the outbox will not be drained');
}

/**
 * Simple helper to shut down the process cleanly.
 */
function shutdown(): void {
  // Guard to avoid running this logic multiple times, for example if we get
  // multiple signals in quick succession.
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (interval) {
    clearInterval(interval);
  }

  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export default {
  fetch: app.fetch,
  port: Number(environment.PORT),
};
