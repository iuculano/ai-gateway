import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import Routes from './embeddings.routes';
import Services from './embeddings.services';

const createEmbedding = defineOpenAPIRoute({
  route: Routes.createEmbedding,
  handler: async (c) => {
    const result = await Services.createEmbedding(c.req.valid('header'), c.req.valid('json'), (id) => {
      c.res.headers.set('ai-log-id', id);
    });
    return result.match(
      (response) => c.json(response, 200),
      (failure) => {
        throw new HTTPException(failure.status as ContentfulStatusCode, {
          message: failure.message,
          ...('upstream' in failure ? { res: new Response(null, { headers: { 'ai-error-source': 'upstream' } }) } : {}),
        });
      },
    );
  },
});

export default new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([createEmbedding] as const);
