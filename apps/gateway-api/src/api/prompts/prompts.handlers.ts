import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './prompts.routes';
import Services from './prompts.services';
import { zodExceptionHook } from '@middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.getPrompt, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getPrompt(params.id);

  return c.json(result, 200);
});

app.openapi(Routes.listPrompts, async (c) => {
  const query = c.req.valid('query');
  const result = await Services.listPrompts(query);

  return c.json(result, 200);
});

app.openapi(Routes.createPrompt, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.createPrompt(body);

  return c.json(result, 201);
});

app.openapi(Routes.updatePrompt, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updatePrompt(params.id, body);  

  return c.json(result, 200);
});

app.openapi(Routes.deletePrompt, async (c) => {
  const params = c.req.valid('param');
  await Services.deletePrompt(params.id);

  return c.body(null, 204);
});

// Versions
app.openapi(Routes.getPromptVersion, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getPrompt(params.id);

  return c.json(result, 200);
});

app.openapi(Routes.createPromptVersion, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.createPrompt(body);

  return c.json(result, 201);
});


app.openapi(Routes.updatePromptVersion, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updatePrompt(params.id, body);  

  return c.json(result, 200);
});

app.openapi(Routes.deletePromptVersion, async (c) => {
  const params = c.req.valid('param');
  await Services.deletePrompt(params.id);

  return c.body(null, 204);
});


export default app;
