import { z } from '@hono/zod-openapi';


const livezResponse = z.object({
  status: z.literal('alive'),
});

const healthzResponse = z.object({
  status: z.literal('ok'),
});

const readyzResponse = z.object({
  status: z.union([z.literal('ok'), z.literal('degraded')]),
  checks: z.object({
    db: z.boolean(),
    db_tables: z.boolean(),
    redis: z.boolean(),
    nats: z.boolean(),
  }),
});


export default {
  livezResponse,
  healthzResponse,
  readyzResponse,
};
