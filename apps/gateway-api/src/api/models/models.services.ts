import { z } from '@hono/zod-openapi';
import { db, sql, and, eq, desc, lt } from '../../clients/drizzle';
import { redis } from '../../clients/redis';
import { models } from '../../db/schema/models'
import { createHash } from 'node:crypto';
import Schemas from './models.schemas';


type GetModelRequest = z.infer<typeof Schemas.getModelRequest>;
type GetModelResponse = z.infer<typeof Schemas.getModelResponse>

async function getModel(modelId: string) : Promise<GetModelResponse> {
  const cacheKey = 'models:' + createHash('sha1').update(modelId).digest('hex');

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await db.select()
    .from(models)
    .where(eq(models.id, modelId));

  // 
  const coerced = Schemas.getModelResponse.parse(result[0]);
  await redis.set(cacheKey, JSON.stringify({ coerced }), { EX: 60 });

  return coerced;
}

type ListModelsRequest = z.infer<typeof Schemas.listModelsRequest>;

async function listModels(modelId: string) : Promise<ListModelsResponse> {
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
  getModel
}
