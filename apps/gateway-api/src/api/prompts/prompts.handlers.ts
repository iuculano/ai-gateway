import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './prompts.routes';
import Services from './prompts.services';
import { zodExceptionHook } from '@middleware/error-handler';


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
 * POST /prompts/:id/render
 * Renders the prompt with the provided input variables.
 *
 * @returns
 * - 200 OK with the prompt body on success.
 */
app.openapi(Routes.renderPrompt, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');

  const prompt = await Services.getPrompt(params.id);
  const render = await Services.renderPrompt(prompt.prompt, body.inputs);
  prompt.prompt = render;

  return c.json(prompt, 200);
});


// Versions
// app.openapi(Routes.getPromptVersion, async (c) => {
//   const params = c.req.valid('param');
//   const result = await Services.getPrompt(params.id);
// 
//   return c.json(result, 200);
// });
// 
// app.openapi(Routes.createPromptVersion, async (c) => {
//   const body = c.req.valid('json');
//   const result = await Services.createPrompt(body);
// 
//   return c.json(result, 201);
// });
// 
// 
// app.openapi(Routes.updatePromptVersion, async (c) => {
//   const params = c.req.valid('param');
//   const body = c.req.valid('json');
//   const result = await Services.updatePrompt(params.id, body);  
// 
//   return c.json(result, 200);
// });
// 
// app.openapi(Routes.deletePromptVersion, async (c) => {
//   const params = c.req.valid('param');
//   await Services.deletePrompt(params.id);
// 
//   return c.body(null, 204);
// });


export default app;
