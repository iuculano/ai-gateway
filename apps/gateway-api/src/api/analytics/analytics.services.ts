import { and, db, eq, gte, lte, max, min, sql, sum } from '@lib/drizzle';
import { createCacheKey, redis } from '@lib/redis';
import { logs } from '../../db/schemas/logs';
import Schemas, {
  type AnalyticsRequest,
  type AnalyticsResponse,
} from './analytics.schemas';
import { parseTags } from '@lib/utils';


/**
 * Queries the analytics data based on the provided parameters.
 *
 * @param request
 * The parameters for querying analytics data.
 *
 * @returns
 * A promise that resolves to the analytics response.
 */
async function queryAnalytics(request: AnalyticsRequest) : Promise<AnalyticsResponse> {
  // This is a relatively expensive query!
  const cacheKey = await createCacheKey('analytics:', request);
  const existing = await redis.get(cacheKey);
  if (existing) {
    return JSON.parse(existing);
  }

  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    request.start_date ? gte(logs.created_at, new Date(request.start_date)) : undefined,
    request.end_date   ? lte(logs.created_at, new Date(request.end_date)) : undefined,
    request.model      ? eq(logs.model, request.model) : undefined,
    request.provider   ? eq(logs.provider, request.provider) : undefined,
    request.status     ? eq(logs.status, request.status) : undefined,
    request.tags       ? sql`${logs.tags} @> ${tagsToFilter}::jsonb` : undefined,
  ];

  const query = Promise.all([
    db.select({
      total_logs: sql<number>`COUNT(*)`.mapWith(Number),
      successful_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} = 'success')`.mapWith(Number),
      error_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} != 'success')`.mapWith(Number),

      total_tokens: sql<number>`COALESCE(SUM(${logs.input_tokens}), 0) + COALESCE(SUM(${logs.output_tokens}), 0)`.mapWith(Number),
      total_input_tokens: sql<number>`COALESCE(SUM(${logs.input_tokens}), 0)`.mapWith(Number),
      total_output_tokens: sql<number>`COALESCE(SUM(${logs.output_tokens}), 0)`.mapWith(Number),

      average_input_tokens: sql<number>`ROUND(AVG(${logs.input_tokens}))`.mapWith(Number),
      average_output_tokens: sql<number>`ROUND(AVG(${logs.output_tokens}))`.mapWith(Number),

      average_output_tokens_per_second: sql<number>`ROUND(AVG(${logs.output_tokens}::numeric / NULLIF(${logs.response_time_ms}, 0) * 1000), 2)`.mapWith(Number),

      cost_total: sql<number>`COALESCE(SUM(${logs.input_cost}), 0) + COALESCE(SUM(${logs.output_cost}), 0)`.mapWith(Number),
      cost_input: sum(logs.input_cost).mapWith(Number),
      cost_output: sum(logs.output_cost).mapWith(Number),

      average_latency_ms: sql<number>`ROUND(AVG(${logs.response_time_ms}))`.mapWith(Number),
      maximum_latency_ms: max(logs.response_time_ms).mapWith(Number),
      minimum_latency_ms: min(logs.response_time_ms).mapWith(Number),
    }).from(logs),

    db.select({
      p50_latency_ms: sql<number>`PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(Number),
      p95_latency_ms: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(Number),
      p99_latency_ms: sql<number>`PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(Number),
    }).from(sql`TABLESAMPLE SYSTEM (10) logs`),
]);

  const data = (await (conditions.length > 0
    ? query.where(and(...conditions))
    : query // Should this even be allowed?
            // Probably need to set some defaults because this can pull a TON
            // of data if no filters are applied
  ));

  const parsed = Schemas.analyticsResponse.parse(data[0]);

  await redis.set(cacheKey, JSON.stringify(parsed), {
    expiration: { type: 'EX', value: 60 * 5 },
  });

  return parsed;
}

export default {
  queryAnalytics
}
