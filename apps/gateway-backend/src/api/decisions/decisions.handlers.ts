import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import { toProviderHttpException } from '../../lib/ai-sdk-providers';
import Routes from './decisions.routes';
import Services from './decisions.services';

/**
 * POST /decisions
 * Answer typed questions about one input.
 */
const createDecision = defineOpenAPIRoute({
  route: Routes.createDecision,
  handler: async (c) => {
    const headers = c.req.valid('header');
    const body = c.req.valid('json');

    const result = await Services.createDecision(headers, body);

    return result.match(
      (decision) => c.json(decision, 200),
      (failure) => {
        throw toProviderHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({
  defaultHook: zodExceptionHook,
}).openapiRoutes([createDecision] as const);

export default app;
