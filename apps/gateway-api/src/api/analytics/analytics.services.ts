import { z } from '@hono/zod-openapi';
import { and, db, eq, gte, lte, max, min, sql, sum } from '../../clients/drizzle';
import { createCacheKey, redis } from '../../clients/redis';
import { logs } from '../../db/schema/logs';
import Schemas from './analytics.schemas';


type AnalyticsRequest = z.infer<typeof Schemas.analyticsRequest>;
type AnalyticsResponse = z.infer<typeof Schemas.analyticsResponse>;

async function queryAnalytics(params: AnalyticsRequest) : Promise<AnalyticsResponse> {
  // Hash the payload to create a unique cache key for Redis
  const cacheKey = await createCacheKey('analytics:', params);

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss,
  const conditions = [
    params.start_date ? gte(logs.created_at, params.start_date) : undefined,
    params.end_date   ? lte(logs.created_at, params.end_date) : undefined,
    params.model      ? eq(logs.model, params.model) : undefined,
    params.provider   ? eq(logs.provider, params.provider) : undefined,
    params.status     ? eq(logs.status, params.status) : undefined,
    params.tags       ? sql`${logs.tags} @> ${JSON.stringify(params.tags)}` : undefined,
  ].filter(x => x !== undefined);


  const query = db.select({
    total_logs: sql<number>`COUNT (*)`.mapWith(Number),
    successful_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} = 'success')`.mapWith(Number),
    error_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} != 'success')`.mapWith(Number),
    total_tokens: sql<number>`SUM(${logs.prompt_tokens} + ${logs.completion_tokens})`.mapWith(Number),
    total_prompt_tokens: sum(logs.prompt_tokens).mapWith(Number),
    total_completion_tokens: sum(logs.completion_tokens).mapWith(Number),
    average_latency_ms: sql<number>`ROUND(AVG(${logs.response_time_ms}))`.mapWith(Number),
    maximum_latency_ms: max(logs.response_time_ms).mapWith(Number),
    minimum_latency_ms: min(logs.response_time_ms).mapWith(Number),
  }).from(logs);

  const data = (await (conditions.length > 0
    ? query.where(and(...conditions))
    : query // Should this even be allowed? 
            // Probably need to set some defaults because this can pull a TON
            // of data if no filters are applied
  ));

  const result = Schemas.analyticsResponse.parse(data[0]);

  await redis.set(cacheKey, JSON.stringify(result), { EX: 60 });
  return result;
}

export default {
  queryAnalytics
}
