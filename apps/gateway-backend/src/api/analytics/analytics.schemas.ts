import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const series = createSchema({
  body: z.object({
    start_date: z.iso.datetime().optional(),
    end_date: z.iso.datetime().optional(),
    interval: z.enum(['hour', 'day', 'none']).default('none'),
    group_by: z.array(z.enum(['model', 'provider', 'status', 'actor'])).default([]),
    model: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),

  response: z.object({
    interval: z.enum(['hour', 'day', 'none']),
    group_by: z.array(z.enum(['model', 'provider', 'status', 'actor'])),
    sealed_through: z.string(),

    points: z.array(
      z.object({
        // Null when interval is 'none'.
        bucket: z.string().nullable(),

        // Null unless the dimension was grouped on.
        model: z.string().nullable(),
        provider: z.string().nullable(),
        status: z.string().nullable(),
        actor_type: z.string().nullable(),
        actor_id: z.string().nullable(),
        actor_label: z.string().nullable(),

        requests: z.number(),
        input_tokens: z.number(),
        output_tokens: z.number(),
        total_tokens: z.number(),

        cost_input: z.number(),
        cost_output: z.number(),
        cost_total: z.number(),

        average_latency_ms: z.number().nullable(),
        minimum_latency_ms: z.number().nullable(),
        maximum_latency_ms: z.number().nullable(),
      }),
    ),
  }),
});

export type AnalyticsSeriesBody = z.infer<typeof series.body>;
export type AnalyticsSeriesResponse = z.infer<typeof series.response>;

export default {
  series,
};
