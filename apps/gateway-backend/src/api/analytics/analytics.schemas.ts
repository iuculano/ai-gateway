import { z } from '@hono/zod-openapi';
import { ACTOR_TYPES } from '@repo/core';
import { createSchema } from '@repo/hono';

// 'bucket' is the hour or day, per the interval.
const dimension = z.enum(['bucket', 'model', 'provider', 'status', 'actor', 'user', 'session']);

const point = z.object({
  // Null unless the dimension was grouped on.
  bucket: z.date().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  status: z.enum(['incomplete', 'complete', 'failed']).nullable(),
  actor_type: z.enum(ACTOR_TYPES).nullable(),
  actor_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  session_id: z.string().nullable(),

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
});

const series = createSchema({
  body: z.object({
    start_date: z.coerce.date().optional(),
    end_date: z.coerce.date().optional(),
    interval: z.enum(['hour', 'day']).default('day'),
    groupings: z.array(z.array(dimension).max(5)).min(1).max(12),
    model: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),
    actor_id: z.uuid().optional(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
  }),

  response: z.object({
    interval: z.enum(['hour', 'day']),
    groupings: z.array(
      z.object({
        group_by: z.array(dimension),
        points: z.array(point),
      }),
    ),
  }),
});

export type AnalyticsDimension = z.infer<typeof dimension>;
export type AnalyticsSeriesBody = z.infer<typeof series.body>;
export type AnalyticsSeriesResponse = z.infer<typeof series.response>;

export default {
  series,
};
