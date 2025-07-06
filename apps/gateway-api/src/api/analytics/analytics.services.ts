import { z } from '@hono/zod-openapi';
import { db, sql, gte, lte, and, eq, sum, avg, max, min } from '../../clients/drizzle';
import { redis } from '../../clients/redis';
import { logs } from '../../db/schema/logs'
import { createHash } from 'node:crypto';
import Schemas from './analytics.schemas';


type AnalyticsRequest = z.infer<typeof Schemas.analyticsRequest>;
type AnalyticsResponse = z.infer<typeof Schemas.analyticsResponse>;

async function queryAnalytics(params: AnalyticsRequest) : Promise<AnalyticsResponse> {
  // Hash the payload to create a unique cache key for Redis
  const keyBase = JSON.stringify(params);
  const cacheKey = 'analytics:' + createHash('sha1').update(keyBase).digest('hex');

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss,
    const conditions = [
      params.start_date     ? gte(logs.created_at, params.start_date) : undefined,
      params.end_date       ? lte(logs.created_at, params.end_date) : undefined,
      params.model          ? eq(logs.model, params.model) : undefined,
      params.provider       ? eq(logs.provider, params.provider) : undefined,
      params.status         ? eq(logs.status, params.status) : undefined,
      params.tags           ? sql`${logs.tags} @> ${JSON.stringify(params.tags)}` : undefined,
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
    : query
  ))[0];

  // Write through to Redis cache
  await redis.set(cacheKey, JSON.stringify(data), { EX: 60 });
  return data;
}

export default {
  queryAnalytics
}
