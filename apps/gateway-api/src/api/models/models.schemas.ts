import { z } from '@hono/zod-openapi';
import { normalizeTimestamp } from '@lib/zod';


const modelShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: z.string(),
  cost_input: z.coerce.number(),
  cost_output: z.coerce.number(),
  config: z.record(z.string(), z.any()).optional().nullable(),
  tags: z.record(z.string(), z.any()).optional().nullable(),
  created_at: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
  updated_at: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
});

const getModelRequest = z.object({
  id: z.string().uuid(),
});

const getModelResponse = modelShape;

const listModelsRequest = z.object({
  name: z.string().optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.string().uuid().optional(), // UUIDv7 cursor
});

const listModelsResponse = z.object({
  data: z.array(modelShape),
  next: z.string().uuid().nullable().optional(),
});

const createModelRequest = modelShape.omit({ 
  id: true, 
  created_at: true,
  updated_at: true,
});

const createModelResponse = modelShape;

const updateModelRequest = modelShape.partial().omit({
  id: true,         // ID is not updated
  created_at: true, // Created at is not updated;
  updated_at: true, // Updated automatically
});

const updateModelResponse = modelShape;

export type GetModelRequest = z.infer<typeof getModelRequest>;
export type GetModelResponse = z.infer<typeof getModelResponse>;
export type ListModelsRequest = z.infer<typeof listModelsRequest>;
export type ListModelsResponse = z.infer<typeof listModelsResponse>;
export type CreateModelRequest = z.infer<typeof createModelRequest>;
export type CreateModelResponse = z.infer<typeof createModelResponse>;
export type UpdateModelRequest = z.infer<typeof updateModelRequest>;
export type UpdateModelResponse = z.infer<typeof updateModelResponse>;

export default {
  getModelRequest,
  getModelResponse,
  listModelsRequest,
  listModelsResponse,
  createModelRequest,
  createModelResponse,
  updateModelRequest,
  updateModelResponse,
};
