import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './embeddings.schemas';


const createEmbedding = createRoute({
  method: 'post',
  path: '/embeddings',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.embeddingsWrite] })],
  request: {
    headers: Schemas.createEmbedding.headers,
    body: { required: true, content: { 'application/json': { schema: Schemas.createEmbedding.body } } },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Embeddings generated',
      content: {
        'application/json': {
          schema: Schemas.createEmbedding.response
        }
      },
    },
  },
});
export default { createEmbedding };
