import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './models.routes';
import Services, { type DeleteModelFailure, type GetModelFailure, type UpdateModelFailure } from './models.services';

/**
 * The HTTP translations, one per service failure union.
 */
function toGetModelHttpException(failure: GetModelFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'MODEL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toUpdateModelHttpException(failure: UpdateModelFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'MODEL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toDeleteModelHttpException(failure: DeleteModelFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'MODEL_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * GET /models/:id
 * Retrieve a specific model by id.
 */
const getModel = defineOpenAPIRoute({
  route: Routes.getModel,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getModel(params.id);

    // Nothing catches the service call: a rejected promise is a malfunction,
    // and the global error handler is what turns those into a sanitized 500.
    return result.match(
      (model) => c.json(model, 200),
      (failure) => {
        throw toGetModelHttpException(failure);
      },
    );
  },
});

/**
 * GET /models
 * Retrieve a list of models.
 */
const listModels = defineOpenAPIRoute({
  route: Routes.listModels,
  handler: async (c) => {
    const query = c.req.valid('query');

    // Plain promise: listing has no outcome the caller could correct.
    const result = await Services.listModels(query);

    return c.json(result, 200);
  },
});

/**
 * POST /models
 * Create a new model.
 */
const createModel = defineOpenAPIRoute({
  route: Routes.createModel,
  handler: async (c) => {
    const json = c.req.valid('json');

    // Also a plain promise: there is nothing about a create to refuse.
    const result = await Services.createModel(json);

    return c.json(result, 201);
  },
});

/**
 * PATCH /models/:id
 * Update an existing model.
 */
const updateModel = defineOpenAPIRoute({
  route: Routes.updateModel,
  handler: async (c) => {
    const params = c.req.valid('param');
    const json = c.req.valid('json');

    const result = await Services.updateModel(params.id, json);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdateModelHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /models/:id
 * Delete an existing model.
 */
const deleteModel = defineOpenAPIRoute({
  route: Routes.deleteModel,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.deleteModel(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeleteModelHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  getModel,
  listModels,
  createModel,
  updateModel,
  deleteModel,
] as const);

export default app;
