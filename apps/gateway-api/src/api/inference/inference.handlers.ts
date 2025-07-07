/*import { OpenAPIHono } from '@hono/zod-openapi';;
import { nats, jsonCodec } from '../../clients/nats';

import Routes from './inference.routes';
import Service from './inference.services';

const app = new OpenAPIHono();

app.openapi(Routes.postInference, async (c) => {
  const headers = c.req.valid('header');
  const data = c.req.valid('json');

  const result = await Service.submitInference({
    api_key: headers['ai-api-key'],
    ...data
  });

  return c.json({
    inference_id: '0197dc75-4c45-76f5-9763-114e4ddaa661',
    status: 'queued' as const,
  }, 200);
});

export default app;
*/