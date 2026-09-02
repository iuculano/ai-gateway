import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './traces.schemas';

const createTrace = createRoute({
  method: 'post' as const,
  path: '/traces',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.tracesWrite] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createTrace.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'The OTLP trace export was accepted.',
      content: {
        'application/json': {
          schema: Schemas.createTrace.response,
        },
      },
    },
  },
});

export default {
  createTrace,
};
