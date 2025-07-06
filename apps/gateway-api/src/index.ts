import { OpenAPIHono } from '@hono/zod-openapi';
import health from './api/health/health.handlers';
import analyticsHandlers from './api/analytics/analytics.handlers';
import logsHandlers from './api/logs/logs.handlers';

const app = new OpenAPIHono();

app.route('/', health);
//app.route('/v1', chatRoutes);
app.route('/v1', analyticsHandlers);
app.route('/v1', logsHandlers);


export default app;
