import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const series = createSchema({
  body: z.object({
    start_date: z.iso.datetime().optional(),
    end_date: z.iso.datetime().optional(),

    // 'none' collapses time entirely, which is what a "top models" or "top
    // callers" list wants - those are rankings, not trends.
    interval: z.enum(['hour', 'day', 'none']).default('none'),

    // Pivot, not filter. The dimensions here become columns on every point;
    // the filters below still narrow which rows are aggregated.
    group_by: z.array(z.enum(['model', 'provider', 'status', 'actor'])).default([]),

    model: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),

    // Only meaningful with interval 'none' - a ranking has a top, a trend does
    // not. Ignored otherwise rather than rejected, so a caller can flip the
    // interval without also having to remember to drop this.
    limit: z.number().int().positive().max(100).optional(),
  }),

  response: z.object({
    interval: z.enum(['hour', 'day', 'none']),
    group_by: z.array(z.enum(['model', 'provider', 'status', 'actor'])),

    /**
     * The exclusive end of what the ROLLUP covers - not the end of the data.
     *
     * Anything newer than this is aggregated from `logs` directly and merged in,
     * so the points are current regardless. This is returned as an operational
     * signal: the further it lags behind now, the more of the answer came from
     * raw rows rather than the rollup, and the slower the query was.
     */
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
