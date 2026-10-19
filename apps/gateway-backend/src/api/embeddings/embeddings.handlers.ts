import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import { toProviderHttpException } from '../../lib/ai-sdk-providers';
import Routes from './embeddings.routes';
import Services from './embeddings.services';

/**
 * POST /embeddings
 * Create embeddings for one or more inputs.
 */
const createEmbedding = defineOpenAPIRoute({
  route: Routes.createEmbedding,
  handler: async (c) => {
    const headers = c.req.valid('header');
    const body = c.req.valid('json');

    const result = await Services.createEmbedding(headers, body);

    return result.match(
      (embeddings) => c.json(embeddings, 200),
      (failure) => {
        throw toProviderHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({
  defaultHook: zodExceptionHook,
}).openapiRoutes([createEmbedding] as const);

export default app;
