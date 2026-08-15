import { createRoute } from '@hono/zod-openapi';
import { authorize } from '@repo/hono';
import { bearerSecurity, validatedProtectedRouteErrors } from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './analytics.schemas';

const postAnalytics = createRoute({
  method: 'post' as const,
  path: '/analytics',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.analytics.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Successful analytics query',
      content: {
        'application/json': {
          schema: Schemas.analytics.response,
        },
      },
    },
  },
});

export default {
  postAnalytics,
};
