import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './prompts.routes';
import Services from './prompts.services';
import { zodExceptionHook } from '@repo/hono';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /prompts/:id
 * Retrieves a singular prompt by ID.
 *
 * @returns
 * - 200 OK with the prompt body on success.
 */
app.openapi(Routes.getPrompt, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getPrompt(params.id);

  return c.json(result, 200);
});

/**
 * GET /prompts
 * Queries prompts with optional filter for tags.
 *
 * Supports pagination.
 *
 * @returns
 * - 200 OK with the prompt body on success.
 */
app.openapi(Routes.listPrompts, async (c) => {
  const query = c.req.valid('query');
  const result = await Services.listPrompts(query);

  return c.json(result, 200);
});

/**
 * POST /prompts
 * Creates a new prompt.
 *
 * @returns
 * - 201 Created with the prompt body on success.
 */
app.openapi(Routes.createPrompt, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.createPrompt(body);

  return c.json(result, 201);
});

/**
 * PATCH /prompts/:id
 * Updates a singular prompt by ID.
 *
 * @returns
 * - 200 OK with the prompt body on success.
 */
app.openapi(Routes.updatePrompt, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updatePrompt(params.id, body);

  return c.json(result, 200);
});

/**
 * DELETE /prompts/:id
 * Deletes a singular prompt by ID.
 *
 * @returns
 * - 204 No Content on success.
 */
app.openapi(Routes.deletePrompt, async (c) => {
  const params = c.req.valid('param');
  await Services.deletePrompt(params.id);

  return c.body(null, 204);
});

/**
 * GET /prompts/:id/versions/:version
 * Retrieves a singular prompt version by version number.
 *
 * @returns
 * - 200 OK with the prompt version body on success.
 */
app.openapi(Routes.getPromptVersion, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getPromptVersion(params.id, params.version);

  return c.json(result, 200);
});

/**
 * GET /prompts/:id/versions
 * Queries versions for a prompt.
 *
 * Supports pagination.
 *
 * @returns
 * - 200 OK with the prompt body on success.
 */
app.openapi(Routes.listPromptVersions, async (c) => {
  const params = c.req.valid('param');
  const query = c.req.valid('query');
  const result = await Services.listPromptVersions(params.id, query);

  return c.json(result, 200);
});

/**
 * POST /prompts/:id/versions
 * Creates a new version for a prompt.
 *
 * @returns
 * - 201 Created with the prompt version body on success.
 */
app.openapi(Routes.createPromptVersion, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.createPromptVersion(params.id, body);

  return c.json(result, 201);
});

/**
 * PATCH /prompts/:id/versions/:version
 * Updates a singular prompt version by version number.
 *
 * @returns
 * - 200 OK with the prompt version body on success.
 */
app.openapi(Routes.updatePromptVersion, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updatePromptVersion(params.id, params.version, body);

  return c.json(result, 200);
});

/**
 * DELETE /prompts/:id/versions/:version
 * Deletes a singular prompt version by version number.
 *
 * @returns
 * - 204 No Content on success.
 */
app.openapi(Routes.deletePromptVersion, async (c) => {
  const params = c.req.valid('param');
  await Services.deletePromptVersion(params.id, params.version);

  return c.body(null, 204);
});

/**
 * POST /prompts/:id/versions/:version
 * Render a prompt version with provided inputs, replacing the templating.
 *
 * @returns
 * - 200 OK with the rendered prompt on success.
 */
app.openapi(Routes.renderPromptVersion, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');

  const prompt = await Services.getPromptVersion(params.id, params.version);
  const result = await Services.renderPromptVersion(prompt.prompt, body.inputs);

  return c.json({
    prompt: result,
  }, 200);
});

export default app;
