import { HTTPException } from 'hono/http-exception';
import { db, and, eq, desc, lt } from '@lib/drizzle';
import { createCacheKey, redis } from '@lib/redis';
import { models } from '@db/schemas/models';
import Schemas, {
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type CreateModelRequest,
  type CreateModelResponse,
  type UpdateModelRequest,
  type UpdateModelResponse,
} from './models.schemas';

/**
 * Retrieves a single model by its ID.
 *
 * @param id
 * The ID of the model to retrieve.
 *
 * @returns
 * A promise that resolves to the model data.
 *
 * @throws {HTTPException}
 * If the model is not found or if multiple models are found.
 */
async function getModel(id: string) : Promise<GetModelResponse> {
  const cacheKey = await createCacheKey('models:', id);
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await db.select()
    .from(models)
    .where(eq(models.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  // Just in case someone manages to find a colliding UUID...
  if (result.length > 1) {
    throw new HTTPException(500, {
      message: 'Returned more than one model for ID',
    });
  }

  // I'm wondering if I even need to cache here - the query is very cheap.
  // This endpoint is called on every inference, though, maybe worth it?
  const parsed = Schemas.getModelResponse.parse(result[0]);
  await redis.set(cacheKey, JSON.stringify(parsed), {
    expiration: { type: 'EX', value: 15 }
  });

  return parsed;
}

/**
 * Retrieves a list of models, filtered by the given criteria..
 *
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the model data.
 *
 * @throws {HTTPException}
 * If the model is not found or if multiple models are found.
 */
async function listModels(request: ListModelsRequest) : Promise<ListModelsResponse> {
  const cacheKey = await createCacheKey('models:', request);
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

  const parsed = Schemas.listModelsResponse.parse({ data: result, next: nextCursor });
  await redis.set(cacheKey, JSON.stringify(parsed), {
    expiration: { type: 'EX', value: 30 },
  });

  return parsed;
}

/**
 * Creates a new model in the database.
 *
 * @param request
 * The request object containing the model data to create.
 *
 * @returns
 * A promise that resolves to the created model data.
 *
 * @throws {HTTPException}
 * If the model creation fails.
 */
async function createModel(request: CreateModelRequest) : Promise<CreateModelResponse> {
  const result = await db.insert(models)
    .values(request)
    .returning();

  if (!result[0]) {
    throw new HTTPException(500, {
      message: 'Failed to create model',
    });
  }

  const parsed = Schemas.createModelResponse.parse(result[0]);
  return parsed;
}

/**
 * Updates an existing model in the database.
 *
 * @param id
 * The ID of the model to update.
 *
 * @param request
 * The request object containing the updated model data.
 *
 * @returns
 * A promise that resolves to the updated model data.
 *
 * @throws {HTTPException}
 * If the model update fails.
 */
async function updateModel(id: string, request: UpdateModelRequest) : Promise<UpdateModelResponse> {
  const result = await db.update(models)
    .set(request)
    .where(eq(models.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(500, {
      message: 'Failed to update model',
    });
  }

  const parsed = Schemas.updateModelResponse.parse(result[0]);
  return parsed;
}

export default {
  getModel,
  listModels,
  createModel,
  updateModel,
}
