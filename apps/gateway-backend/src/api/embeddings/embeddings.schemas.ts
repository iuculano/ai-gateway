import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const headers = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),

  // Bring-your-own-key.
  'ai-api-key': z.string().min(1),
  'ai-base-url': z.url().optional(),
  'ai-routing-strategy': z.enum(['random', 'weighted', 'cost']).optional(),
  'ai-routing-weights': z.string().optional(),
  'ai-log-tags': z.string().optional(),
  'ai-log-omit-request': z.stringbool().optional(),
  'ai-log-omit-response': z.stringbool().optional(),
  'ai-max-retries': z.coerce.number().int().min(0).max(10).optional(),
  'ai-timeout-ms': z.coerce.number().int().positive().optional(),
});

const responseHeaders = z.object({
  'ai-trace-id': z.string().regex(/^[0-9a-f]{32}$/),
});

const body = z.object({
  model: z.string().min(1), // This is a little special here and can be 'provider/model' instead...
  input: z.union([z.string(), z.array(z.string()).min(1).max(2048)]),
  dimensions: z.number().int().positive().nullish(),
  encoding_format: z.enum(['float', 'base64']).nullish(),
  user: z.string().nullish(),
});

const embeddingList = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      object: z.literal('embedding'),
      index: z.number().int().nonnegative(),
      embedding: z.union([z.array(z.number()), z.string()]),
    }),
  ),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

const createEmbedding = createSchema({
  headers: headers,
  body: body,
  response: embeddingList,
});

export type EmbeddingHeaders = z.infer<typeof headers>;
export type EmbeddingBody = z.infer<typeof body>;
export type EmbeddingList = z.infer<typeof embeddingList>;

export default {
  createEmbedding,
  responseHeaders,
};
