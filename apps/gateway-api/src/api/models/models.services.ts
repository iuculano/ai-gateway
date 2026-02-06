import { HTTPException } from 'hono/http-exception';
import { db, and, eq, desc, lt } from '@lib/drizzle';
import { models } from '@db/schemas/models';
import Schemas, {
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type CreateModelRequest,
  type CreateModelResponse,
  type UpdateModelRequest,
  type UpdateModelResponse,
  type DeleteModelResponse,
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
  const result = await db.select()
    .from(models)
    .where(eq(models.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getModelResponse.parse(result[0]);
  return parsed;
}

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
async function getModelBySlug(slug: string) : Promise<GetModelResponse> {
  // If we have an invalid slug, just act like it doesn't exist
  const split = slug.split('/');
  if (split.length !== 2) {
    throw new HTTPException(404);
  }

  const result = await db.select()
    .from(models)
    .where(and(
      eq(models.provider, split[0] as string), 
      eq(models.name, split[1] as string),
    ));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  // I'm wondering if I even need to cache here - the query is very cheap.
  // This endpoint is called on every inference, though, maybe worth it?
  const parsed = Schemas.getModelResponse.parse(result[0]);
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
 */
async function updateModel(id: string, request: UpdateModelRequest) : Promise<UpdateModelResponse> {
  const result = await db.update(models)
    .set(request)
    .where(eq(models.id, id))
    .returning();

  // Almost guaranteed that the model doesn't exist.
  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.updateModelResponse.parse(result[0]);
  return parsed;
}

/**
 * Deletes an existing model in the database.
 *
 * @param id
 * The ID of the model to update.
 *
 * @param request
 * The request object containing the updated model data.
 *
 * @returns
 * A promise that resolves to the updated model data.
 */
async function deleteModel(id: string) : Promise<DeleteModelResponse> {
  const result = await db.delete(models)
    .where(eq(models.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }

  return null as DeleteModelResponse;
}

export default {
  getModel,
  getModelBySlug,
  listModels,
  createModel,
  updateModel,
  deleteModel,
}
