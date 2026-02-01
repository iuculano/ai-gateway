import { z } from '@hono/zod-openapi';
import InferenceSchemas from '../inference/inference.schemas';

const logShape = z.object({
  id: z.uuidv7(),
  model: z.string(),
  provider: z.string(),
  status: z.string(),
  input_tokens: z.number().optional().nullable(),
  output_tokens: z.number().optional().nullable(),
  input_cost: z.number().optional(),
  output_cost: z.number().optional(),
  response_time_ms: z.number().optional().nullable(),
  object_reference: z.string().optional().nullable(), // Reference to the object in the provider's system
  tags: z.record(z.string(), z.any()).optional().nullable(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getLogRequest = z.object({
  id: z.uuidv7(),
});

const getLogResponse = logShape;

// Be careful of this, it's duplicated from inference.schemas.ts
const getLogDataResponse = InferenceSchemas.inferenceObjectData;

const listLogsRequest = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string(), z.any()).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.uuidv7().optional(), // UUIDv7 cursor
});

const listLogsResponse = z.object({
  data: z.array(logShape.omit({
    object_reference: true, // Internal
  })),
  next: z.uuidv7().nullable().optional(),
});

const createLogRequest = logShape.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

const createLogResponse = logShape;

const updateLogRequest = logShape.partial().omit({
  id: true,         // ID is not updated
  created_at: true, // Created at is not updated;
  updated_at: true, // Updated automatically
});

const updateLogResponse = logShape;

export type GetLogResponse = z.infer<typeof getLogResponse>;
export type GetLogRequest = z.infer<typeof getLogRequest>;
export type GetLogDataResponse = z.infer<typeof getLogDataResponse>;
export type ListLogsRequest = z.infer<typeof listLogsRequest>;
export type ListLogsResponse = z.infer<typeof listLogsResponse>;
export type CreateLogRequest = z.infer<typeof createLogRequest>;
export type CreateLogResponse = z.infer<typeof createLogResponse>;
export type UpdateLogRequest =  z.infer<typeof updateLogRequest>;
export type UpdateLogResponse = z.infer<typeof updateLogResponse>;

export default {
  getLogRequest,
  getLogResponse,
  getLogDataResponse,
  listLogsRequest,
  listLogsResponse,
  createLogRequest,
  createLogResponse,
  updateLogRequest,
  updateLogResponse,
};
