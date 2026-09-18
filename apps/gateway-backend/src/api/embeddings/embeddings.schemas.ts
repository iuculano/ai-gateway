import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono/util';

const tokens = z.array(z.number().int().nonnegative()).min(1);

// https://developers.openai.com/api/reference/resources/embeddings/methods/create
const createEmbedding = createSchema({
  headers: z.object({
    'ai-api-key': z.string().optional(),
    'ai-base-url': z.string().optional(),
    'ai-log-tags': z.string().optional(),
    'ai-log-omit-request': z.boolean().optional(),
    'ai-log-omit-response': z.boolean().optional(),
    'ai-timeout-ms': z.number().int().optional(),
  }),

  body: z.object({
    model: z.string().min(1),
    input: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1).max(2048),
      tokens,
      z.array(tokens).min(1).max(2048),
    ]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
    user: z.string().optional(),
  }),

  response: z.object({
    object: z.literal('list'),
    data: z.array(z.object({
      object: z.literal('embedding'),
      index: z.number().int().nonnegative(),
      embedding: z.union([z.array(z.number()), z.string()]),
    })),
    model: z.string(),
    usage: z.object({
      prompt_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    }),
  }),
});

export type CreateEmbeddingHeaders = z.infer<typeof createEmbedding.headers>;
export type CreateEmbeddingBody = z.infer<typeof createEmbedding.body>;
export type CreateEmbeddingResponse = z.infer<typeof createEmbedding.response>;

export default {
  createEmbedding,
};
