import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './models.routes';
import Services, { type GetModelFailure } from './models.services';

// The HTTP translations, one per service failure union.
function toGetModelHttpException(failure: GetModelFailure): HTTPException {
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
    const result = await Services.listModels(query);

    return c.json(result, 200);
  },
});

/**
 * GET /models/providers
 * Retrieve a page of providers with their models.
 */
const listProviders = defineOpenAPIRoute({
  route: Routes.listProviders,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listProviders(query);

    return c.json(result, 200);
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  listProviders,
  getModel,
  listModels,
] as const);

export default app;
