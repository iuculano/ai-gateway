import { z } from '@hono/zod-openapi';


const inferenceHeaders = z.object({
  'ai-api-key': z.string(),
  'ai-base-url': z.string().url().optional(),

  // Unused for now.
  'ai-cache-skip': z.boolean().optional(),
  'ai-cache-ttl': z.number().optional(),
});

const inferenceRequest = z.object({
  model_id: z.string().uuid(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
});

const inferenceResponse = z.object({
  id: z.string().uuid(),
  text: z.string(),
  reasoning: z.string().optional(),
  sources: z.array(z.string()).optional(),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
  reponse_time_ms: z.number().optional(),
});

const inferenceObjectData = z.object({
  request: inferenceRequest,
  response: inferenceResponse,
});

export type InferenceHeaders = z.infer<typeof inferenceHeaders>;
export type InferenceRequest = z.infer<typeof inferenceRequest>;
export type InferenceResponse = z.infer<typeof inferenceResponse>;
export type InferenceObjectData = z.infer<typeof inferenceObjectData>;

export default {
  inferenceHeaders,
  inferenceRequest,
  inferenceResponse,
  inferenceObjectData,
};
