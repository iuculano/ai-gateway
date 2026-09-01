import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './prompts.routes';
import Services, {
  type CreatePromptFailure,
  type CreatePromptVersionFailure,
  type DeletePromptFailure,
  type DeletePromptVersionFailure,
  type GetPromptFailure,
  type GetPromptVersionFailure,
  type ListPromptVersionsFailure,
  type RenderPromptVersionFailure,
  type UpdatePromptFailure,
  type UpdatePromptVersionFailure,
} from './prompts.services';

/**
 * The HTTP translations, one per service failure union.
 *
 * A name collision is a 409 rather than a 400: the body is well formed and the
 * request would have succeeded a moment earlier, which is the distinction the
 * two codes carry.
 */
function nameTakenError(name: string): HTTPException {
  return new HTTPException(409, {
    message: `A prompt named '${name}' already exists`,
  });
}

function toGetPromptHttpException(failure: GetPromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toCreatePromptHttpException(failure: CreatePromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NAME_TAKEN':
      return nameTakenError(failure.name);

    default:
      return assertNever(code);
  }
}

function toUpdatePromptHttpException(failure: UpdatePromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404);

    case 'PROMPT_NAME_TAKEN':
      return nameTakenError(failure.name);

    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(422, {
        message: `Version ${failure.version} does not exist on this prompt`,
      });

    default:
      return assertNever(code);
  }
}

function toDeletePromptHttpException(failure: DeletePromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toGetPromptVersionHttpException(failure: GetPromptVersionFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toListPromptVersionsHttpException(failure: ListPromptVersionsFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toCreatePromptVersionHttpException(failure: CreatePromptVersionFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toUpdatePromptVersionHttpException(failure: UpdatePromptVersionFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toDeletePromptVersionHttpException(failure: DeletePromptVersionFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(404);

    case 'PROMPT_VERSION_ACTIVE':
      return new HTTPException(409, {
        message: 'Cannot delete the active version of a prompt',
      });

    default:
      return assertNever(code);
  }
}

function toRenderPromptVersionHttpException(failure: RenderPromptVersionFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * POST /prompts
 * Create a new prompt.
 */
const createPrompt = defineOpenAPIRoute({
  route: Routes.createPrompt,
  handler: async (c) => {
    const body = c.req.valid('json');

    const result = await Services.createPrompt(body);

    return result.match(
      (prompt) => c.json(prompt, 201),
      (failure) => {
        throw toCreatePromptHttpException(failure);
      },
    );
  },
});

/**
 * GET /prompts
 * Retrieve a list of prompts.
 */
const listPrompts = defineOpenAPIRoute({
  route: Routes.listPrompts,
  handler: async (c) => {
    const query = c.req.valid('query');

    const result = await Services.listPrompts(query);

    return c.json(result, 200);
  },
});

/**
 * GET /prompts/:id
 * Retrieve a specific prompt by id.
 */
const getPrompt = defineOpenAPIRoute({
  route: Routes.getPrompt,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.getPrompt(params.id);

    return result.match(
      (prompt) => c.json(prompt, 200),
      (failure) => {
        throw toGetPromptHttpException(failure);
      },
    );
  },
});

/**
 * PATCH /prompts/:id
 * Update an existing prompt.
 */
const updatePrompt = defineOpenAPIRoute({
  route: Routes.updatePrompt,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.updatePrompt(params.id, body);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdatePromptHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /prompts/:id
 * Delete an existing prompt and every version under it.
 */
const deletePrompt = defineOpenAPIRoute({
  route: Routes.deletePrompt,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.deletePrompt(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeletePromptHttpException(failure);
      },
    );
  },
});

/**
 * POST /prompts/:id/versions
 * Create a new version of a prompt.
 */
const createPromptVersion = defineOpenAPIRoute({
  route: Routes.createPromptVersion,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.createPromptVersion(params.id, body);

    return result.match(
      (version) => c.json(version, 201),
      (failure) => {
        throw toCreatePromptVersionHttpException(failure);
      },
    );
  },
});

/**
 * GET /prompts/:id/versions
 * Retrieve a list of versions for a prompt.
 */
const listPromptVersions = defineOpenAPIRoute({
  route: Routes.listPromptVersions,
  handler: async (c) => {
    const params = c.req.valid('param');
    const query = c.req.valid('query');

    const result = await Services.listPromptVersions(params.id, query);

    return result.match(
      (versions) => c.json(versions, 200),
      (failure) => {
        throw toListPromptVersionsHttpException(failure);
      },
    );
  },
});

/**
 * POST /prompts/:id/versions/:version/render
 * Render a prompt version with the supplied inputs.
 */
const renderPromptVersion = defineOpenAPIRoute({
  route: Routes.renderPromptVersion,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.renderPromptVersion(params.id, params.version, body.inputs);

    return result.match(
      (rendered) => c.json(rendered, 200),
      (failure) => {
        throw toRenderPromptVersionHttpException(failure);
      },
    );
  },
});

/**
 * GET /prompts/:id/versions/:version
 * Retrieve a specific version of a prompt.
 */
const getPromptVersion = defineOpenAPIRoute({
  route: Routes.getPromptVersion,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.getPromptVersion(params.id, params.version);

    return result.match(
      (version) => c.json(version, 200),
      (failure) => {
        throw toGetPromptVersionHttpException(failure);
      },
    );
  },
});

/**
 * PATCH /prompts/:id/versions/:version
 * Update an existing version of a prompt.
 */
const updatePromptVersion = defineOpenAPIRoute({
  route: Routes.updatePromptVersion,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.updatePromptVersion(params.id, params.version, body);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdatePromptVersionHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /prompts/:id/versions/:version
 * Delete a single version of a prompt.
 */
const deletePromptVersion = defineOpenAPIRoute({
  route: Routes.deletePromptVersion,
  handler: async (c) => {
    const params = c.req.valid('param');

    const result = await Services.deletePromptVersion(params.id, params.version);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeletePromptVersionHttpException(failure);
      },
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  createPrompt,
  listPrompts,
  getPrompt,
  updatePrompt,
  deletePrompt,

  createPromptVersion,
  listPromptVersions,
  renderPromptVersion,
  getPromptVersion,
  updatePromptVersion,
  deletePromptVersion,
] as const);

export default app;
