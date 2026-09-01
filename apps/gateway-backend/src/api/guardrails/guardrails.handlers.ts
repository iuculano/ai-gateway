import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './guardrails.routes';
import Services, {
  type DeleteGuardrailFailure,
  type GetGuardrailFailure,
  type UpdateRegexGuardrailFailure,
} from './guardrails.services';

// The HTTP translations, one per service failure union.
function toGetGuardrailHttpException(failure: GetGuardrailFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'GUARDRAIL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toUpdateRegexGuardrailHttpException(failure: UpdateRegexGuardrailFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'GUARDRAIL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toDeleteGuardrailHttpException(failure: DeleteGuardrailFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'GUARDRAIL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * POST /guardrails/evaluate
 * Run the organization's guardrails against the supplied content.
 */
const evaluateGuardrails = defineOpenAPIRoute({
  route: Routes.evaluateGuardrails,
  handler: async (c) => {
    const body = c.req.valid('json');

    const result = await Services.evaluateGuardrails(body);

    return c.json(result, 200);
  },
});

/**
 * POST /guardrails/regex
 * Create a regex guardrail.
 */
const createRegexGuardrail = defineOpenAPIRoute({
  route: Routes.createRegexGuardrail,
  handler: async (c) => {
    const body = c.req.valid('json');

    const result = await Services.createRegexGuardrail(body);

    return c.json(result, 201);
  },
});

/**
 * PATCH /guardrails/regex/:id
 * Update an existing regex guardrail.
 */
const updateRegexGuardrail = defineOpenAPIRoute({
  route: Routes.updateRegexGuardrail,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.updateRegexGuardrail(params.id, body);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdateRegexGuardrailHttpException(failure);
      },
    );
  },
});

/**
 * GET /guardrails
 * Retrieve a list of guardrails, of any type.
 */
const listGuardrails = defineOpenAPIRoute({
  route: Routes.listGuardrails,
  handler: async (c) => {
    const query = c.req.valid('query');

    const result = await Services.listGuardrails(query);

    return c.json(result, 200);
  },
});

/**
 * GET /guardrails/:id
 * Retrieve a specific guardrail by id.
 */
const getGuardrail = defineOpenAPIRoute({
  route: Routes.getGuardrail,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.getGuardrail(params.id);

    return result.match(
      (guardrail) => c.json(guardrail, 200),
      (failure) => {
        throw toGetGuardrailHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /guardrails/:id
 * Delete an existing guardrail.
 */
const deleteGuardrail = defineOpenAPIRoute({
  route: Routes.deleteGuardrail,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.deleteGuardrail(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeleteGuardrailHttpException(failure);
      },
    );
  },
});

// Order matters: `openapiRoutes` registers in array order and Hono matches in
// registration order, so the static paths have to precede `/guardrails/:id` or
// `:id` swallows `evaluate` and `regex` - the same trap webhooks.handlers.ts
// documents.
const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  evaluateGuardrails,
  createRegexGuardrail,
  updateRegexGuardrail,
  listGuardrails,
  getGuardrail,
  deleteGuardrail,
] as const);

export default app;
