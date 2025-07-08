import { z } from '@hono/zod-openapi';
import { db, sql, and, eq, desc, lt } from '../../clients/drizzle';
import { redis } from '../../clients/redis';
import { logs } from '../../db/schema/logs'
import { createHash } from 'node:crypto';
import Schemas from './logs.schemas';


type GetLogRequest = z.infer<typeof Schemas.getLogRequest>;
type GetLogResponse = z.infer<typeof Schemas.getLogResponse>;

async function getLog(request: GetLogRequest) : Promise<GetLogResponse> {
  const cacheKey = 'logs:' + createHash('sha1').update(request.id).digest('hex');

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await db.select()
    .from(logs)
    .where(eq(logs.id, request.id));

  // Drizzle treats numeric as a string to avoid precision nonsense.
  // We only use 4 decimal places of precision and JS Number is guaranteed to
  // have enough precision for what we're returning.
  // 
  // Just let Zod coerce the object Drizzle returned into its actual Zod 
  // schema shape.
  const coerced = Schemas.getLogResponse.parse(result[0]);
  await redis.set(cacheKey, JSON.stringify(coerced), { EX: 60 });

  return coerced;
}


type ListLogsRequest = z.infer<typeof Schemas.listLogsRequest>;
type ListLogsResponse = z.infer<typeof Schemas.listLogsResponse>;

async function listLogs(request: ListLogsRequest) : Promise<ListLogsResponse> {
  // Hash the payload to create a unique cache key for Redis
  const keyBase = JSON.stringify(request);
  const cacheKey = 'logs:' + createHash('sha1').update(keyBase).digest('hex');

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const conditions = [
    request.model    ? eq(logs.model, request.model) : undefined,
    request.provider ? eq(logs.provider, request.provider) : undefined,
    request.status   ? eq(logs.status, request.status) : undefined,
    request.tags     ? sql`${logs.tags} @> ${JSON.stringify(request.tags)}` : undefined,
    request.after_id ? lt(logs.id, request.after_id) : undefined,
  ].filter(x => x !== undefined);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(logs)
    .where(whereClause)
    .orderBy(desc(logs.id))
    .limit(request.limit);

  const nextCursor = result.length === (request.limit)
    ? result[result.length - 1].id
    : null;

  // Write through to Redis cache
  const coerced = Schemas.listLogsResponse.parse({ data: result, next: nextCursor });
  await redis.set(cacheKey, JSON.stringify(coerced), { EX: 60 });

  return coerced;
}

export default {
  getLog,
  listLogs
}
