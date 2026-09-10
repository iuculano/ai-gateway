import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './actors.routes';
import Services from './actors.services';

/**
 * POST /actors/resolve
 * Resolves actor references to their corresponding names.
 *
 * This endpoint should be considered internal.
 */
const resolveActors = defineOpenAPIRoute({
  route: Routes.resolveActors,
  handler: async (c) => {
    const result = c.json(await Services.resolveActors(c.req.valid('json')), 200);
    return result;
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  resolveActors,
] as const);

export default app;
