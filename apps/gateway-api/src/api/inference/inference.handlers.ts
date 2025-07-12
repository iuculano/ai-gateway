import { OpenAPIHono } from '@hono/zod-openapi';;
import Routes from './inference.routes';
import Services from './inference.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.postInference, async (c) => {
  const headers = c.req.valid('header');
  const data = c.req.valid('json');

  const result = await Services.submitInference({
    api_key: headers['ai-api-key'],
    base_url: headers['ai-base-url'],
    ...data
  });

  return c.json(result, 200);
});

export default app;
