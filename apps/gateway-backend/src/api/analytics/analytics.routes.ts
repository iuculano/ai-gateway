import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './analytics.schemas';

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
      description: 'Time series and/or breakdown over the logs',
      content: {
        'application/json': {
          schema: Schemas.series.response,
        },
      },
    },
  },
});

const postAnalyticsUsers = createRoute({
  method: 'post' as const,
  path: '/analytics/users',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.users.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'A page of the users behind the logs, and how many there are',
      content: {
        'application/json': {
          schema: Schemas.users.response,
        },
      },
    },
  },
});

const postAnalyticsSessions = createRoute({
  method: 'post' as const,
  path: '/analytics/sessions',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.sessions.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'How many sessions there were, and the most expensive',
      content: {
        'application/json': {
          schema: Schemas.sessions.response,
        },
      },
    },
  },
});

const postAnalyticsTokens = createRoute({
  method: 'post' as const,
  path: '/analytics/tokens',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.tokens.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Tokens in, out and from the prompt cache, and how big requests and answers are',
      content: {
        'application/json': {
          schema: Schemas.tokens.response,
        },
      },
    },
  },
});

export default {
  postAnalyticsSeries,
  postAnalyticsUsers,
  postAnalyticsSessions,
  postAnalyticsTokens,
};
