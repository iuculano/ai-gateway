import { z } from '@hono/zod-openapi';


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

const getModelRequest = z.object({
  id: z.uuidv7(),
});

const getModelResponse = modelShape;

const listModelsRequest = z.object({
  name: z.string().optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.uuidv7().optional(), // UUIDv7 cursor
});

const listModelsResponse = z.object({
  data: z.array(modelShape),
  next: z.uuidv7().nullable(),
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

const deleteModelRequest = z.object({
  id: z.uuidv7(),
});

const deleteModelResponse = z.never();

export type GetModelRequest = z.infer<typeof getModelRequest>;
export type GetModelResponse = z.infer<typeof getModelResponse>;
export type ListModelsRequest = z.infer<typeof listModelsRequest>;
export type ListModelsResponse = z.infer<typeof listModelsResponse>;
export type CreateModelRequest = z.infer<typeof createModelRequest>;
export type CreateModelResponse = z.infer<typeof createModelResponse>;
export type UpdateModelRequest = z.infer<typeof updateModelRequest>;
export type UpdateModelResponse = z.infer<typeof updateModelResponse>;
export type DeleteModelRequest = z.infer<typeof deleteModelRequest>;
export type DeleteModelResponse = z.infer<typeof deleteModelResponse>;

export default {
  getModelRequest,
  getModelResponse,
  listModelsRequest,
  listModelsResponse,
  createModelRequest,
  createModelResponse,
  updateModelRequest,
  updateModelResponse,
  deleteModelRequest,
  deleteModelResponse,
};
