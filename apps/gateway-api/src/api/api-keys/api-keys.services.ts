import { HTTPException } from 'hono/http-exception';
import { randomBytes } from 'node:crypto';
import { and, db, eq, lt } from '@repo/drizzle';
import { apiKeys } from '@repo/drizzle/schemas';
import Schemas, {
  type GetApiKeyResponse,
  type ListApiKeysQuery,
  type ListApiKeysResponse,
  type CreateApiKeyBody,
  type CreateApiKeyResponse,
  type UpdateApiKeyBody,
  type UpdateApiKeyResponse,
  type DeleteApiKeyResponse,
} from './api-keys.schemas';

/**
 * Retrieves a single API key by its ID.
 *
 * @param id
 * The ID of the API key to retrieve.
 *
 * @returns
 * A promise that resolves to the API key data.
 */
async function getApiKey(id: string) : Promise<GetApiKeyResponse> {
  const result = await db.select()
    .from(apiKeys)
    .where(eq(apiKeys.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getApiKey.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a list of API keys, filtered by the given criteria.
 *
 * @param query
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the API key data.
 */
async function listApiKeys(query: ListApiKeysQuery) : Promise<ListApiKeysResponse> {
  const conditions = [
    query.after_id  ? lt(apiKeys.id, query.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(apiKeys)
    .where(whereClause)
    .limit(query.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > query.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listApiKeys.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new API key entry in the database.
 *
 * @param body
 * The request object containing the API key data to be created.
 *
 * @returns
 * A promise that resolves to the created API key data.
 */
async function createApiKey(body: CreateApiKeyBody) : Promise<CreateApiKeyResponse> {
  const key = `aig_${randomBytes(30).toString('hex')}`;
  const hasher = new Bun.CryptoHasher('sha256', process.env.API_KEY_SECRET_KEY);
  const hashed = hasher.update(key).digest('hex');

  const payload = {
    ...body,
    key_hash: hashed,
  };

  const result = await db.insert(apiKeys)
    .values(payload)
    .returning();

  const parsed = Schemas.createApiKey.response.parse(result[0]);
  return parsed;
}

/**
 * Updates an existing API key entry in the database.
 *
 * @param id
 * The ID of the API key to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated API key data.
 */
async function updateApiKey(id: string, body: UpdateApiKeyBody) : Promise<UpdateApiKeyResponse> {

}

/**
 * Deletes an existing API key entry in the database.
 *
 * @param id
 * The ID of the API key to delete.
 *
 * @returns
 * Nothing.
 */
async function deleteApiKey(id: string) : Promise<DeleteApiKeyResponse> {
  const result = await db.delete(apiKeys)
    .where(eq(apiKeys.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }
}

export default {
  getApiKey,
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
}
