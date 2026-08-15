import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { getCaller, zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './audit-logs.routes';
import Services, { type GetAuditLogFailure } from './audit-logs.services';

function toGetAuditLogHttpException(failure: GetAuditLogFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'AUDIT_LOG_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * GET /audit-logs/:id
 * Retrieve a specific audit log by id.
 */
const getAuditLog = defineOpenAPIRoute({
  route: Routes.getAuditLog,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.getAuditLog(getCaller(), params.id);

    // Nothing catches the service call: a rejected promise is a malfunction,
    // and the global error handler is what turns those into a sanitized 500.
    return result.match(
      (log) => c.json(log, 200),
      (failure) => {
        throw toGetAuditLogHttpException(failure);
      },
    );
  },
});

/**
 * GET /audit-logs
 * Retrieve a list of audit logs.
 */
const listAuditLogs = defineOpenAPIRoute({
  route: Routes.listAuditLogs,
  handler: async (c) => {
    const query = c.req.valid('query');

    const result = await Services.listAuditLogs(getCaller(), query);

    return c.json(result, 200);
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([getAuditLog, listAuditLogs] as const);

export default app;
