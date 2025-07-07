import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui'
import healthHandlers from './api/health/health.handlers';
import analyticsHandlers from './api/analytics/analytics.handlers';
import logsHandlers from './api/logs/logs.handlers';
import modelsHandlers from './api/models/models.handlers';


const app = new OpenAPIHono();

app.doc('/open-api.json', {
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
app.route('/v1', analyticsHandlers);
app.route('/v1', logsHandlers);
app.route('/v1', modelsHandlers);


export default app;
