import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
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

const postAnalyticsSeries = createRoute({
  method: 'post' as const,
  path: '/analytics/series',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.series.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Time series and/or breakdown served from the hourly rollup',
      content: {
        'application/json': {
          schema: Schemas.series.response,
        },
      },
    },
  },
});

export default {
  postAnalytics,
  postAnalyticsSeries,
};
