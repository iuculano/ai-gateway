import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './inference.routes';
import Services from './inference.services';
import { zodExceptionHook } from '../../middleware/error-handler';
import { streamSSE } from 'hono/streaming';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.postInference, async (c) => {
  const headers = c.req.valid('header');
  const json = c.req.valid('json');

  if (!json.stream) {
    const result = await Services.submitInference(headers, json);
    return c.json(result, 200);
  }

  else {
    const stream = await Services.submitInferenceStreaming(headers, json);

    return streamSSE(c, async sse => {
      for await (const chunk of stream) {
        await sse.writeSSE({ data: chunk });
      }

      await sse.writeSSE({ data: '[DONE]' });
    });
  }
});

export default app;
