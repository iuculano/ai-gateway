import { z } from '@hono/zod-openapi';
import { normalizeTimestamp } from '../../utils/zod';


const logShape = z.object({
  id: z.string().uuid(),
  model: z.string(),
  provider: z.string(),
  status: z.string(),
  prompt_tokens: z.number().optional().nullable(),
  completion_tokens: z.number().optional().nullable(),
  response_time_ms: z.number().optional().nullable(),
  object_reference: z.string().optional().nullable(), // Reference to the object in the provider's system
  tags: z.record(z.string(), z.any()).optional().nullable(),
  created_at: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
  updated_at: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
});

const getLogRequest = z.object({
  id: z.string().uuid(),
});

const getLogResponse = logShape;

// Be careful of this, it's duplicated from inference.schemas.ts
const getLogDataResponse = z.object({
  request: z.object({
    model_id: z.string().uuid(),
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
  }),

  response: z.object({
    id: z.string().uuid(),
    text: z.string(),
    reasoning: z.string().optional(),
    sources: z.array(z.string()).optional(),
    usage: z.object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    }),
    response_time_ms: z.number().optional(),
  }),
});


const listLogsRequest = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string(), z.any()).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  after_id: z.string().uuid().optional(), // UUIDv7 cursor
});

const listLogsResponse = z.object({
  data: z.array(logShape.omit({
    object_reference: true, // Internal
  })),
  next: z.string().uuid().nullable().optional(),
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
