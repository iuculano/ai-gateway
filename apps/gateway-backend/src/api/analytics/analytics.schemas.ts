import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const analytics = createSchema({
  body: z.object({
    start_date: z.iso.datetime().optional(),
    end_date: z.iso.datetime().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    // The column's own enum, not a bare string. A free-form status could never
    // match a row, and typing it loosely is what let the counters below drift
    // to a value the column cannot hold.
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),
    tags: z.string().optional(),
  }),

  response: z.object({
    total_logs: z.number(),
    successful_logs: z.number(),
    error_logs: z.number(),

    total_tokens: z.number(),
    total_input_tokens: z.number(),
    total_output_tokens: z.number(),

    average_input_tokens: z.number().nullable(),
    average_output_tokens: z.number().nullable(),

    average_output_tokens_per_second: z.number().nullable(),
    // average_time_to_first_token_ms: z.number().nullable(),

    cost_total: z.number(),
    cost_input: z.number(),
    cost_output: z.number(),

    average_latency_ms: z.number().nullable(),
    maximum_latency_ms: z.number().nullable(),
    minimum_latency_ms: z.number().nullable(),

    p50_latency_ms: z.number().nullable(),
    p95_latency_ms: z.number().nullable(),
    p99_latency_ms: z.number().nullable(),
  }),
});

export type AnalyticsBody = z.infer<typeof analytics.body>;
export type AnalyticsResponse = z.infer<typeof analytics.response>;

export default {
  analytics,
};
