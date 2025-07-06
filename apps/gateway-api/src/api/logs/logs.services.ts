import { z } from '@hono/zod-openapi';
import { db, sql, and, eq, desc, lt } from '../../clients/drizzle';
import { redis } from '../../clients/redis';
import { logs } from '../../db/schema/logs'
import { createHash } from 'node:crypto';
import Schemas from './logs.schemas';


type LogsRequest = z.infer<typeof Schemas.getLogsRequest>;
type LogsResponse = z.infer<typeof Schemas.getLogsResponse>

async function queryLogs(params: LogsRequest) : Promise<LogsResponse> {
  // Hash the payload to create a unique cache key for Redis
  const keyBase = JSON.stringify(params);
  const cacheKey = 'logs:' + createHash('sha1').update(keyBase).digest('hex');

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const conditions = [
    params.model     ? eq(logs.model, params.model) : undefined,
    params.provider  ? eq(logs.provider, params.provider) : undefined,
    params.status    ? eq(logs.status, params.status) : undefined,
    params.tags      ? sql`${logs.tags} @> ${JSON.stringify(params.tags)}` : undefined,
    params.after_id  ? lt(logs.id, params.after_id) : undefined,
  ].filter(x => x !== undefined);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = await db.select()
    .from(logs)
    .where(whereClause)
    .orderBy(desc(logs.id))
    .limit(params.limit ?? 50);

  const nextCursor = rows.length === (params.limit ?? 50)
    ? rows[rows.length - 1].id
    : null;

  // Write through to Redis cache
  await redis.set(cacheKey, JSON.stringify({ data: rows, next: nextCursor }), { EX: 60 });

  return {
    data: rows,
    next: nextCursor,
  };
}

export default {
  queryLogs
}
