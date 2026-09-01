import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './logs.routes';
import Services, { type DeleteLogFailure, type GetLogFailure, type GetLogPayloadFailure } from './logs.services';

// The HTTP translations, one per service failure union.
function toGetLogHttpException(failure: GetLogFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'LOG_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * All three payload failures are a 404, and the message is the whole difference
 * between them - which is why the service keeps them apart rather than
 * answering one collapsed "not found".
 */
function toGetLogPayloadHttpException(failure: GetLogPayloadFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'LOG_NOT_FOUND':
      return new HTTPException(404);

    case 'PAYLOAD_NOT_STORED':
      return new HTTPException(404, {
        message: `No ${failure.side} payload was stored for this log`,
      });

    case 'PAYLOAD_UNAVAILABLE':
      return new HTTPException(404, {
        message: `The ${failure.side} payload for this log is no longer available`,
      });

    default:
      return assertNever(code);
  }
}

function toDeleteLogHttpException(failure: DeleteLogFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'LOG_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * GET /logs/:id
 *
 * Retrieve a specific log by id.
 */
const getLog = defineOpenAPIRoute({
  route: Routes.getLog,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getLog(params.id);

    return result.match(
      (log) => c.json(log, 200),
      (failure) => {
        throw toGetLogHttpException(failure);
      },
    );
  },
});

/**
 * GET /logs/:id/request
 *
 * Retrieve the request payload as it was submitted.
 */
const getLogRequest = defineOpenAPIRoute({
  route: Routes.getLogRequest,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getLogPayload(params.id, 'request');

    return result.match(
      (payload) => c.json(payload, 200),
      (failure) => {
        throw toGetLogPayloadHttpException(failure);
      },
    );
  },
});

/**
 * GET /logs/:id/response
 *
 * Retrieve the response payload as it was returned.
 */
const getLogResponse = defineOpenAPIRoute({
  route: Routes.getLogResponse,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getLogPayload(params.id, 'response');

    return result.match(
      (payload) => c.json(payload, 200),
      (failure) => {
        throw toGetLogPayloadHttpException(failure);
      },
    );
  },
});

/**
 * POST /logs/batch/request
 *
 * Retrieve many request payloads at once, fetched concurrently.
 */
const getLogRequestBatch = defineOpenAPIRoute({
  route: Routes.getLogRequestBatch,
  handler: async (c) => {
    const body = c.req.valid('json');
    const result = await Services.getLogPayloadBatch(body.ids, 'request');

    return c.json(result, 200);
  },
});

/**
 * POST /logs/batch/response
 *
 * Retrieve many response payloads at once, fetched concurrently.
 */
const getLogResponseBatch = defineOpenAPIRoute({
  route: Routes.getLogResponseBatch,
  handler: async (c) => {
    const body = c.req.valid('json');
    const result = await Services.getLogPayloadBatch(body.ids, 'response');

    return c.json(result, 200);
  },
});

/**
 * GET /logs
 *
 * Retrieve a list of logs.
 */
const listLogs = defineOpenAPIRoute({
  route: Routes.listLogs,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listLogs(query);

    return c.json(result, 200);
  },
});

/**
 * GET /logs/stats
 *
 * Totals for the organization, counted or estimated depending on size.
 */
const getLogStats = defineOpenAPIRoute({
  route: Routes.getLogStats,
  handler: async (c) => {
    const result = await Services.getLogStats();

    return c.json(result, 200);
  },
});

/**
 * DELETE /logs/:id
 *
 * Delete a log and both of its stored payloads.
 */
const deleteLog = defineOpenAPIRoute({
  route: Routes.deleteLog,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.deleteLog(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeleteLogHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  getLogStats,
  getLog,
  getLogRequest,
  getLogResponse,
  getLogRequestBatch,
  getLogResponseBatch,
  listLogs,
  deleteLog,
] as const);

export default app;
