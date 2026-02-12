import { z } from '@hono/zod-openapi';
import { createSchema } from '@lib/schema';


const modelShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  provider: z.string(),
  cost_input: z.coerce.number().nonnegative(),
  cost_output: z.coerce.number().nonnegative(),
  config: z.record(z.string(), z.unknown()).optional(),
  tags: z.record(z.string(), z.unknown()).optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
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
      more_data: z.boolean()
    }),
  }),
});

const createModel = createSchema({
  body: modelShape.omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: modelShape,
});

const updateModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: modelShape.partial().omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: modelShape,
});

const deleteModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

export type GetModelParams = z.infer<typeof getModel.params>;
export type GetModelResponse = z.infer<typeof getModel.response>;
export type ListModelsRequest = z.infer<typeof listModels.query>;
export type ListModelsResponse = z.infer<typeof listModels.response>;
export type CreateModelRequest = z.infer<typeof createModel.body>;
export type CreateModelResponse = z.infer<typeof createModel.response>;
export type UpdateModelRequest = z.infer<typeof updateModel.body>;
export type UpdateModelResponse = z.infer<typeof updateModel.response>;
export type DeleteModelRequest = z.infer<typeof deleteModel.params>;
export type DeleteModelResponse = z.infer<typeof deleteModel.response>;

export default {
  getModel,
  listModels,
  createModel,
  updateModel,
  deleteModel,
};

