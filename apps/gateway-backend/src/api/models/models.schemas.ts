import { z } from '@hono/zod-openapi';
import { models } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createSelectSchema } from 'drizzle-orm/zod';

const modelShape = createSelectSchema(models, {
  config: z.record(z.string(), z.unknown()).nullable(),
  tags: z.record(z.string(), z.string()).nullable(),
});

const getModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: modelShape,
});

const listModels = createSchema({
  query: z.object({
    name: z.string().optional(),
    provider: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(modelShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const listProviders = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    after_id: z.string().min(1).optional(), // Provider name cursor, in alphabetical order.
  }),

  response: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        synced_at: z.date().nullable(),
        models: z.array(modelShape),
      }),
    ),
    meta: z.object({
      oldest_id: z.string().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

export type GetModelParams = z.infer<typeof getModel.params>;
export type GetModelResponse = z.infer<typeof getModel.response>;
export type ListModelsRequest = z.infer<typeof listModels.query>;
export type ListModelsResponse = z.infer<typeof listModels.response>;
export type ListProvidersQuery = z.infer<typeof listProviders.query>;
export type ListProvidersResponse = z.infer<typeof listProviders.response>;

export default {
  getModel,
  listModels,
  listProviders,
};
