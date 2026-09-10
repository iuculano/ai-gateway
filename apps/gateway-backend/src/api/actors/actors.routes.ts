import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './actors.schemas';

const resolveActors = createRoute({
  method: 'post',
  path: '/actors/resolve',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.actorsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.resolveActors.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Resolves actor references to their corresponding names',
      content: {
        'application/json': {
          schema: Schemas.resolveActors.response
        }
      },
    },
  },
});

export default { 
  resolveActors 
};
