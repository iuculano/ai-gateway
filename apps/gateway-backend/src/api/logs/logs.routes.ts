import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize } from '@repo/hono';
import {
  bearerSecurity,
  protectedRouteErrors,
  validatedProtectedRouteErrors,
} from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './logs.schemas';

/**
 * Note the absence of POST and PATCH.
 *
 * Log rows are written by the gateway on the inference path, never by a client
 * - an endpoint that lets a caller author its own log entries would let it
 * fabricate usage records and forge the audit surface those records feed. The
 * create/update paths live in the service layer, reachable only from
 * ingestion.
 *
 * DELETE stays, because a tenant deleting its own conversations is a
 * legitimate and frequently mandatory operation.
 */

/**
 * The sanitized 500 the global error handler produces for anything that
 * rejects. Declared per route because that is this project's convention, and
 * shared from here so seven copies cannot drift apart.
 */
const internalServerError = {
  description: 'Internal server error',
  content: {
    'application/json': {
      schema: httpError,
    },
  },
};

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
    500: internalServerError,
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
    500: internalServerError,
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
    500: internalServerError,
  },
});

/**
 * POST, not GET, for both batch routes: the id list is the payload, and a few
 * hundred UUIDs in a query string runs into proxy URL limits well before the
 * documented maximum of 100 becomes the binding constraint.
 */
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
    500: internalServerError,
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
    500: internalServerError,
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
    500: internalServerError,
  },
});

/**
 * Registered BEFORE /logs/:id.
 *
 * `/logs/stats` and `/logs/:id` are both GET and both match this path. If the
 * parameterised route wins, "stats" is bound to :id, fails the uuidv7 check and
 * answers 400 - a routing bug wearing a validation error's clothes. The two
 * batch routes avoid this only by being POST.
 */
const getLogStats = createRoute({
  method: 'get' as const,
  path: '/logs/stats',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.logsRead] })],
  responses: {
    ...protectedRouteErrors,
    200: {
      description:
        'Totals for the organization. Counted exactly up to 100,000 logs; above that the figures are ' +
        'sampled and `estimated` is true, with an error under roughly 1%.',
      content: {
        'application/json': {
          schema: Schemas.stats.response,
        },
      },
    },
    500: internalServerError,
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
    500: internalServerError,
  },
});

export default {
  getLog,
  getLogRequest,
  getLogResponse,
  getLogRequestBatch,
  getLogResponseBatch,
  listLogs,
  getLogStats,
  deleteLog,
};
