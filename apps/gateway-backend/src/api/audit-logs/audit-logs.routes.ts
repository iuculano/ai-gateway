import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './audit-logs.schemas';

const getAuditLog = createRoute({
  method: 'get' as const,
  path: '/audit-logs/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.auditLogsRead] })],
  request: {
    params: Schemas.getAuditLog.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Audit log retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getAuditLog.response,
        },
      },
    },
    404: {
      description: 'Audit log entry not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const listAuditLogs = createRoute({
  method: 'get' as const,
  path: '/audit-logs',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.auditLogsRead] })],
  request: {
    query: Schemas.listAuditLogs.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Audit logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listAuditLogs.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  getAuditLog,
  listAuditLogs,
};
