import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './traces.routes';
import Services from './traces.services';

/**
 * POST /traces
 * Accept an OTLP/HTTP JSON trace export.
 */
const createTrace = defineOpenAPIRoute({
  route: Routes.createTrace,
  handler: async (c) => {
    const body = c.req.valid('json');
    const response = await Services.createTrace(body);

    return c.json(response, 200);
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([createTrace] as const);

export default app;
