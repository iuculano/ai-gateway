import { OpenAPIHono } from '@hono/zod-openapi';
import healthHandlers from './api/health/health.handlers';

// Middleware
import { secureHeaders } from 'hono/secure-headers'
import { requestId } from 'hono/request-id'
import { errorHandler } from '@repo/hono';
import { environment } from './environment';

import { tickAuditLogProcessor } from './worker/audit-log-processor';

export const app = new OpenAPIHono();

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

app.route('/', healthHandlers);

let shuttingDown = false;

const interval = setInterval(() => {
  void tickAuditLogProcessor();
}, environment.WORKER_POLL_INTERVAL_MS);

const shutdown = () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  clearInterval(interval);
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);


export default {
  fetch: app.fetch,
  port: Number(environment.PORT),
};
