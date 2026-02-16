import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui'
import healthHandlers from './api/health/health.handlers';

// Middleware
import { secureHeaders } from 'hono/secure-headers'
import { requestId } from 'hono/request-id'
import { errorHandler } from './middleware/error-handler';
import { environment } from '@lib/environment';

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

app.get('/docs', swaggerUI({
  url: '/open-api.json'
}));

app.route('/', healthHandlers);


let shuttingDown = false;

const interval = setInterval(() => {
  void tickWebhookProcessor();
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
