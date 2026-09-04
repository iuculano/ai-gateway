import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './traces.routes';
import Services, { type GetTraceFailure } from './traces.services';

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

/**
 * POST /traces
 * Accept an OTLP/HTTP JSON trace export.
 */
const createTrace = defineOpenAPIRoute({
  route: Routes.createTrace,
  handler: async (c) => {
    const body = c.req.valid('json');
    const response = await Services.createTrace(body);

    return c.json(response, 200);
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
