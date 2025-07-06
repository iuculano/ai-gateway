import { z } from '@hono/zod-openapi';


const modelShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: z.string(),

  cost_input: z.number(),
  cost_output: z.number(),

  config: z.record(z.string(), z.any()).nullable(),
  tags: z.record(z.string(), z.any()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const getModelRequest = z.object({
  model_id: z.string().uuid(),
});

export const getModelResponse = modelShape;

export const listModelsRequest = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string(), z.any()).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.string().uuid().optional(), // UUIDv7 cursor
});

export const listModelsResponse = z.object({
  data: z.array(modelShape),
  next: z.string().uuid().nullable().optional(),
});



export default {
  getModelRequest,
  getModelResponse,
  listModelsResponse,
};
