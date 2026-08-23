import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { requestId } from 'hono/request-id';

import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { environment } from './environment';

import { tickAnalyticsRollup } from './worker/rollup-refresh';

export const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

app.doc31('/open-api.json', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'worker-analytics-rollup',
  },
});

app.route('/', healthHandlers);

let shuttingDown = false;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || shuttingDown) {
    return;
  }

  ticking = true;

  try {
    const result = await tickAnalyticsRollup();

    // 'idle' is the steady state between hours and says nothing worth saying
    // every five minutes. The other outcomes are worth a line each.
    if (result.status !== 'idle') {
      logger.info(
        {
          status: result.status,
          chunks: result.chunks,
          rows: result.rows,
          from: result.from?.toISOString(),
          to: result.to?.toISOString(),
        },
        'Analytics rollup refreshed',
      );
    }
  } catch (error) {
    // Nothing above this catches, and an unhandled rejection here would take
    // the process down. Every row this writes is derivable from `logs`, so a
    // stale rollup is a stale dashboard rather than lost data; the next tick
    // recomputes the same range from scratch.
    logger.error({ err: error }, 'Analytics rollup tick failed');
  } finally {
    ticking = false;
  }
}

const interval = environment.WORKER_ENABLED
  ? setInterval(() => void tick(), environment.WORKER_POLL_INTERVAL_MS)
  : null;

if (environment.WORKER_ENABLED) {
  logger.info(
    {
      poll_interval_ms: environment.WORKER_POLL_INTERVAL_MS,
      trailing_window_hours: environment.ROLLUP_TRAILING_WINDOW_HOURS,
      chunk_hours: environment.ROLLUP_CHUNK_HOURS,
    },
    'Analytics rollup worker started',
  );

  // setInterval does not fire until the interval has elapsed. On a fresh
  // deployment the rollup is empty and this first pass IS the backfill, so
  // waiting out an interval before starting it serves nothing.
  void tick();
} else {
  logger.warn('Analytics rollup is disabled by WORKER_ENABLED - the rollup will not be refreshed');
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
