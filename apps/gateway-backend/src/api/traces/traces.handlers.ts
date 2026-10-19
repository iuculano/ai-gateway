import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './traces.routes';
import Services, { type CreateTraceFailure, type GetTraceFailure } from './traces.services';

// The HTTP translations, one per service failure union.
function toGetTraceHttpException(failure: GetTraceFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'TRACE_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

// OTLP exporters retry 429, 502, 503 and 504 and give up on anything else, so
// only an unavailable store may be answered with a retryable status.
function toCreateTraceHttpException(failure: CreateTraceFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'TRACE_EXPORT_REJECTED':
      return failure.status === 413
        ? new HTTPException(413, { message: 'The trace export is too large' })
        : new HTTPException(400, { message: 'The trace store rejected the export' });

    case 'TRACE_STORE_UNAVAILABLE':
      return new HTTPException(503, { message: 'The trace store is unavailable', cause: failure.cause });

    default:
      return assertNever(code);
  }
}

/**
 * POST /traces
 * Accept an OTLP/HTTP JSON trace export.
 */
const createTrace = defineOpenAPIRoute({
  route: Routes.createTrace,
  handler: async (c) => {
    const body = c.req.valid('json');
    const result = await Services.createTrace(body);

    return result.match(
      (response) => c.json(response, 200),
      (failure) => {
        throw toCreateTraceHttpException(failure);
      },
    );
  },
});

/**
 * GET /traces
 * Retrieve a page of trace summaries, newest run first.
 */
const listTraces = defineOpenAPIRoute({
  route: Routes.listTraces,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listTraces(query);

    return c.json(result, 200);
  },
});

/**
 * GET /traces/:trace_id
 * Retrieve one trace's summary and its normalized waterfall.
 */
const getTrace = defineOpenAPIRoute({
  route: Routes.getTrace,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getTrace(params.trace_id);

    return result.match(
      (trace) => c.json(trace, 200),
      (failure) => {
        throw toGetTraceHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  createTrace,
  listTraces,
  getTrace,
] as const);

export default app;
