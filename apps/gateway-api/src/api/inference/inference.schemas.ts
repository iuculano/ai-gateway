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

const inferenceResponseStreaming = z.object({
  inference_id: z.string().uuid(),
  status: z.literal('queued'),
});

const inferenceResponseNonStreaming = z.object({
  inference_id: z.string().uuid(),
  status: z.literal('queued'),
});

export default {
  inferenceHeaders,
  inferenceRequest,
  inferenceResponseStreaming,
  inferenceResponseNonStreaming,
};
