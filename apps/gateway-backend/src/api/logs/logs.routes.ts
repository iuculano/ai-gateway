import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, protectedRouteErrors, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './logs.schemas';

const getLog = createRoute({
  method: 'get' as const,
  path: '/logs/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    params: Schemas.getLog.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Log retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getLog.response,
        },
      },
    },
    404: {
      description: 'Log not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const getLogRequest = createRoute({
  method: 'get' as const,
  path: '/logs/{id}/request',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    params: Schemas.getLogRequest.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'The request payload as it was submitted',
      content: {
        'application/json': {
          schema: Schemas.getLogRequest.response,
        },
      },
    },
    404: {
      description: 'Log not found, or no request payload was stored for it',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const getLogResponse = createRoute({
  method: 'get' as const,
  path: '/logs/{id}/response',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    params: Schemas.getLogResponse.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'The response payload as it was returned',
      content: {
        'application/json': {
          schema: Schemas.getLogResponse.response,
        },
      },
    },
    404: {
      description: 'Log not found, or no response payload was stored for it',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const getLogRequestBatch = createRoute({
  method: 'post' as const,
  path: '/logs/batch/request',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.batch.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Request payloads, keyed by log id',
      content: {
        'application/json': {
          schema: Schemas.batch.response,
        },
      },
    },
  },
});

const getLogResponseBatch = createRoute({
  method: 'post' as const,
  path: '/logs/batch/response',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.batch.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Response payloads, keyed by log id',
      content: {
        'application/json': {
          schema: Schemas.batch.response,
        },
      },
    },
  },
});

const listLogs = createRoute({
  method: 'get' as const,
  path: '/logs',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  request: {
    query: Schemas.listLogs.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listLogs.response,
        },
      },
    },
  },
});


const countLogs = createRoute({
  method: 'get' as const,
  path: '/logs/count',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  responses: {
    ...protectedRouteErrors,
    200: {
      description: 'Totals for the organization',
      content: {
        'application/json': {
          schema: Schemas.countLogs.response,
        },
      },
    },
  },
});

const deleteLog = createRoute({
  method: 'delete' as const,
  path: '/logs/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsWrite] })],
  request: {
    params: Schemas.deleteLog.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Log and its stored payloads deleted',
    },
    404: {
      description: 'Log not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  getLog,
  getLogRequest,
  getLogResponse,
  getLogRequestBatch,
  getLogResponseBatch,
  listLogs,
  countLogs,
  deleteLog,
};
