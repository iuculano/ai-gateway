import { z } from '@hono/zod-openapi';


const logShape = z.object({
  id: z.string().uuid(),
  model: z.string(),
  provider: z.string(),
  status: z.string(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  response_time_ms: z.number().nullable(),
  cost: z.number(),
  tags: z.record(z.string(), z.any()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const getLogRequest = z.object({
  id: z.string().uuid(),
});

export const getLogResponse = logShape;

export const listLogsRequest = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string(), z.any()).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.string().uuid().optional(), // UUIDv7 cursor
});

export const listLogsResponse = z.object({
  data: z.array(logShape),
  next: z.string().uuid().nullable().optional(),
});

export default {
  getLogRequest,
  getLogResponse,
  listLogsRequest,
  listLogsResponse,
};
