import { OpenAPIHono } from '@hono/zod-openapi';
import { clickhouse, ensureSchema } from '@repo/clickhouse';
import { logger } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { requestId } from 'hono/request-id';

import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { environment } from './environment';

import { tickAnalyticsSync } from './worker/clickhouse-sync';

export const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

// Health checks only: private, so like the backend's they aren't published.
app.route('/', healthHandlers);

let ticking = false;

async function tick(): Promise<void> {
  // Already doing work, skip this tick to avoid overlapping executions.
  if (ticking) {
    return;
  }

  // Start working on this tick.
  ticking = true;

  try {
    const result = await tickAnalyticsSync();

    // Idle ticks stay quiet.
    if (result.rows > 0) {
      logger.info(result, 'Analytics synced to ClickHouse');
    }
  } catch (error) {
    // Probably don't need to go down in flames if something goes wrong.
    //
    // Every row is in Postgres, so a failed tick is stale analytics rather than
    // lost data and we'll pick up where we left off on the next tick.
    logger.error({ err: error }, 'Analytics sync tick failed');
  } finally {
    ticking = false;
  }
}

if (environment.WORKER_ENABLED) {
  await ensureSchema(clickhouse);

  setInterval(() => void tick(), environment.WORKER_POLL_INTERVAL_MS);
  logger.info(
    { poll_interval_ms: environment.WORKER_POLL_INTERVAL_MS, batch_rows: environment.SYNC_BATCH_ROWS },
    'Analytics sync to ClickHouse started',
  );

  void tick();
} else {
  logger.warn('Analytics sync is disabled by WORKER_ENABLED - ClickHouse will not receive new logs');
}

const shutdown = () => process.exit(0);

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export default {
  fetch: app.fetch,
  port: Number(environment.PORT),
};
