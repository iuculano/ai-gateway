import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const livez = createSchema({
  response: z.object({
    status: z.literal('alive'),
  }),
});

const readyz = createSchema({
  response: z.object({
    status: z.union([z.literal('ok'), z.literal('degraded')]),
    checks: z.object({
      db: z.boolean(),
      db_tables: z.boolean(),
    }),
  }),
});

export default {
  livez,
  readyz,
};
