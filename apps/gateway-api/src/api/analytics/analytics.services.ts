import { and, db, eq, gte, lte, max, min, sql, sum } from '../../clients/drizzle';
import { createCacheKey, redis } from '../../clients/redis';
import { logs } from '../../db/schema/logs';
import Schemas, {
  type AnalyticsRequest,
  type AnalyticsResponse,
} from './analytics.schemas';


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
  // Hash the payload to create a unique cache key for Redis
  const cacheKey = await createCacheKey('analytics:', request);

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const conditions = [
    request.start_date ? gte(logs.created_at, request.start_date) : undefined,
    request.end_date   ? lte(logs.created_at, request.end_date) : undefined,
    request.model      ? eq(logs.model, request.model) : undefined,
    request.provider   ? eq(logs.provider, request.provider) : undefined,
    request.status     ? eq(logs.status, request.status) : undefined,
    request.tags       ? sql`${logs.tags} @> ${JSON.stringify(request.tags)}` : undefined,
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

  const parsed = Schemas.analyticsResponse.parse(data[0]);

  await redis.set(cacheKey, JSON.stringify(parsed), {
    expiration: { type: 'EX', value: 60 * 5 },
  });

  return parsed;
}

export default {
  queryAnalytics
}
