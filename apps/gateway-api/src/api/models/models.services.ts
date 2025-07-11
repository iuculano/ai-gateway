import { HTTPException } from 'hono/http-exception';
import { z } from '@hono/zod-openapi';
import { db, and, eq, desc, lt } from '../../clients/drizzle';
import { redis } from '../../clients/redis';
import { models } from '../../db/schema/models'
import { createHash } from 'node:crypto';
import Schemas from './models.schemas';


type GetModelRequest = z.infer<typeof Schemas.getModelRequest>;
type GetModelResponse = z.infer<typeof Schemas.getModelResponse>

async function getModel(request: GetModelRequest) : Promise<GetModelResponse> {
  const cacheKey = 'models:' + createHash('sha1').update(request.id).digest('hex');

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await db.select()
    .from(models)
    .where(eq(models.id, request.id));

  if (result.length === 0) {
    throw new HTTPException(404);
  }

  if (result.length > 1) {
    throw new HTTPException(500, {
      cause: 'Multiple models found with the same ID',
    });
  }

  // Drizzle treats numeric as a string to avoid precision nonsense.
  // We only use 4 decimal places of precision and JS Number is guaranteed to
  // have enough precision for what we're returning.
  // 
  // Just let Zod coerce the object Drizzle returned into its actual Zod 
  // schema shape.
  const coerced = Schemas.getModelResponse.parse(result[0]);
  await redis.set(cacheKey, JSON.stringify(coerced), { EX: 60 });

  return coerced;
}

type ListModelsRequest = z.infer<typeof Schemas.listModelsRequest>;
type ListModelsResponse = z.infer<typeof Schemas.listModelsResponse>;

async function listModels(request: ListModelsRequest) : Promise<ListModelsResponse> {
  // Hash the payload to create a unique cache key for Redis
  const keyBase = JSON.stringify(request);
  const cacheKey = 'models:' + createHash('sha1').update(keyBase).digest('hex');

  // See if the data is already cached in Redis
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const conditions = [
    request.name     ? eq(models.name, request.name) : undefined,
    request.provider ? eq(models.provider, request.provider) : undefined,
    request.after_id ? lt(models.id, request.after_id) : undefined,
  ].filter(x => x !== undefined);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(models)
    .where(whereClause)
    .orderBy(desc(models.id))
    .limit(request.limit);

  const nextCursor = result.length === (request.limit)
    ? result[result.length - 1]?.id ?? null
    : null;

  // Write through to Redis cache
  const coerced = Schemas.listModelsResponse.parse({ data: result, next: nextCursor });
  await redis.set(cacheKey, JSON.stringify(coerced), { EX: 60 });

  return coerced;
}

type CreateModelRequest = z.infer<typeof Schemas.createModelRequest>;
type CreateModelResponse = z.infer<typeof Schemas.createModelResponse>;

async function createModel(request: CreateModelRequest) : Promise<CreateModelResponse> {
  const result = await db.insert(models)
    .values(request)
    .returning();

  const coerced = Schemas.createModelResponse.parse(result[0]);
  return coerced;
}

export default {
  getModel,
  listModels,
  createModel,
}
