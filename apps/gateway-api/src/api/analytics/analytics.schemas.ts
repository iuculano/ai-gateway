import { z } from '@hono/zod-openapi';
import { normalizeTimestamp } from '../../utils/zod';


const analyticsRequest = z.object({
  start_date: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
  end_date: z.preprocess(normalizeTimestamp, z.string().datetime().optional()),
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.any()).optional(),
});

const analyticsResponse = z.object({
  total_logs: z.number(),
  successful_logs: z.number(),
  error_logs: z.number(),
  total_tokens: z.number(),
  total_prompt_tokens: z.number(),
  total_completion_tokens: z.number(),
  average_latency_ms: z.number(),
  maximum_latency_ms: z.number(),
  minimum_latency_ms: z.number(),
});

export type AnalyticsRequest = z.infer<typeof analyticsRequest>;
export type AnalyticsResponse = z.infer<typeof analyticsResponse>;

export default {
  analyticsRequest,
  analyticsResponse,
};
