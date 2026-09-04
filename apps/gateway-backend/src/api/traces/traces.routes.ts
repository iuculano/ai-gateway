import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
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

const listTraces = createRoute({
  method: 'get' as const,
  path: '/traces',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.tracesRead] })],
  request: {
    query: Schemas.listTraces.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Trace summaries retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listTraces.response,
        },
      },
    },
  },
});

const getTrace = createRoute({
  method: 'get' as const,
  path: '/traces/{trace_id}', // not the row uuid
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.tracesRead] })],
  request: {
    params: Schemas.getTrace.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'The trace summary',
      content: {
        'application/json': {
          schema: Schemas.getTrace.response,
        },
      },
    },
    404: {
      description: 'No trace with this id has been ingested for this organization',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  createTrace,
  listTraces,
  getTrace,
};
