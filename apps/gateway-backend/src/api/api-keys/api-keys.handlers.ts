import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './api-keys.routes';
import Services, {
  type CreateApiKeyFailure,
  type GetApiKeyFailure,
  type GetApiKeyStatsFailure,
  type RevokeApiKeyFailure,
  type UpdateApiKeyFailure,
} from './api-keys.services';

// Helper so the insufficient_scope header cannot drift between callers.
function ungrantableScopesError(held: string[], ungrantable: string[]): HTTPException {
  const ungrantableJoined = ungrantable.join(' ');

  return new HTTPException(403, {
    cause: `Cannot grant unheld scopes - holds '${held.join(' ')}', requested '${ungrantableJoined}'`,

    res: new Response(null, {
      headers: {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${ungrantableJoined}"`,
      },
    }),
  });
}

// The HTTP translations, one per service failure union.
function toGetApiKeyHttpException(failure: GetApiKeyFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'API_KEY_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toGetApiKeyStatsHttpException(failure: GetApiKeyStatsFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'API_KEY_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toCreateApiKeyHttpException(failure: CreateApiKeyFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'UNGRANTABLE_SCOPES':
      return ungrantableScopesError(failure.held, failure.ungrantable);

    default:
      return assertNever(code);
  }
}

function toUpdateApiKeyHttpException(failure: UpdateApiKeyFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'UNGRANTABLE_SCOPES':
      return ungrantableScopesError(failure.held, failure.ungrantable);

    case 'API_KEY_NOT_FOUND':
      return new HTTPException(404);

    case 'API_KEY_REVOKED':
      return new HTTPException(409, {
        message: 'Cannot update a revoked API key',
      });

    default:
      return assertNever(code);
  }
}

function toRevokeApiKeyHttpException(failure: RevokeApiKeyFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'API_KEY_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * GET /api-keys/:id
 * Retrieve a specific API key by id.
 */
const getApiKey = defineOpenAPIRoute({
  route: Routes.getApiKey,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getApiKey(params.id);

    return result.match(
      (key) => c.json(key, 200),
      (failure) => {
        throw toGetApiKeyHttpException(failure);
      },
    );
  },
});

/**
 * GET /api-keys/:id/stats
 * Retrieve statistics for a specific API key by id.
 */
const getApiKeyStats = defineOpenAPIRoute({
  route: Routes.getApiKeyStats,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getApiKeyStats(params.id);

    return result.match(
      (stats) => c.json(stats, 200),
      (failure) => {
        throw toGetApiKeyStatsHttpException(failure);
      },
    );
  },
});

/**
 * GET /api-keys
 * Retrieve a list of API keys.
 */
const listApiKeys = defineOpenAPIRoute({
  route: Routes.listApiKeys,
  handler: async (c) => {
    const query = c.req.valid('query');

    // Plain promise: listing has no outcome the caller could correct.
    const result = await Services.listApiKeys(query);

    return c.json(result, 200);
  },
});

/**
 * POST /api-keys
 * Create a new API key. The plaintext key is only present in this response.
 */
const createApiKey = defineOpenAPIRoute({
  route: Routes.createApiKey,
  handler: async (c) => {
    const body = c.req.valid('json');

    const result = await Services.createApiKey(body);

    return result.match(
      (created) => c.json(created, 201),
      (failure) => {
        throw toCreateApiKeyHttpException(failure);
      },
    );
  },
});

/**
 * PATCH /api-keys/:id
 * Update an existing API key.
 */
const updateApiKey = defineOpenAPIRoute({
  route: Routes.updateApiKey,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.updateApiKey(params.id, body);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdateApiKeyHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /api-keys/:id
 * Revoke an API key. Keys are never hard-deleted.
 */
const revokeApiKey = defineOpenAPIRoute({
  route: Routes.revokeApiKey,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.revokeApiKey(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toRevokeApiKeyHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  getApiKey,
  getApiKeyStats,
  listApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
] as const);

export default app;
