import { z } from '@hono/zod-openapi';


const inferenceHeaders = z.object({
  'ai-api-key': z.string(),
  'ai-base-url': z.string().url().optional(),

  // Unused for now.
  'ai-cache-skip': z.boolean().optional(),
  'ai-cache-ttl': z.number().optional(),
});

const inferenceModelParameters = z.object({
  system_prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
});

const inferenceBase = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })),
  stream: z.boolean().optional(),
  output_schema: z.record(z.string(), z.any()).optional(),
});

const inferenceSimple = z.object({
  ...inferenceBase.shape,

  model: z.string(),
  parameters: inferenceModelParameters.optional(),
});

const inferenceComplex = z.object({
  ...inferenceBase.shape,

  strategy: z.object({
    mode: z.enum(['fallback', 'weighted', 'shadowed']).default('fallback'),
    targets: z.array(z.object({
      model: z.string(),
      weight: z.number().positive().optional(),
      parameters: inferenceModelParameters.optional(),
    })).min(1),
  }),
});

const inferenceRequest = z.union([
  inferenceSimple, 
  inferenceComplex,
]);

const inferenceResponse = z.object({
  id: z.string().uuid(),
  model: z.string(),
  provider: z.string(),
  text: z.string(),
  reasoning: z.string().optional(),
  sources: z.array(z.string()).optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
    cost_estimate: z.number().min(0).optional(),
  }),
  response_time_ms: z.number().optional(),
});

const inferenceObjectData = z.object({
  request: inferenceRequest,
  response: inferenceResponse,
});

export type InferenceHeaders = z.infer<typeof inferenceHeaders>;
export type InferenceRequest = z.infer<typeof inferenceRequest>;
export type InferenceResponse = z.infer<typeof inferenceResponse>;
export type InferenceObjectData = z.infer<typeof inferenceObjectData>;

export type InferenceRequestSimple = z.infer<typeof inferenceSimple>;
export type InferenceRequestComplex = z.infer<typeof inferenceComplex>;

export type InferenceStrategy = z.infer<typeof inferenceComplex.shape.strategy>;

export default {
  inferenceHeaders,
  inferenceRequest,
  inferenceResponse,
  inferenceObjectData,
};
