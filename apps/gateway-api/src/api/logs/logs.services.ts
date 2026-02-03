import { HTTPException } from 'hono/http-exception';
import { db, sql, and, eq, desc, lt } from '@lib/drizzle';
import { redis, createCacheKey } from '@lib/redis';
import { logs } from '../../db/schemas/logs'
import { s3 } from '@lib/s3';
import Schemas, {
  type GetLogResponse,
  type GetLogDataResponse,
  type ListLogsRequest,
  type ListLogsResponse,
  type CreateLogRequest,
  type CreateLogResponse,
  type UpdateLogRequest,
  type UpdateLogResponse,
} from './logs.schemas';


/**
 * Retrieves a single log by its ID.
 *
 * @param id
 * The ID of the log to retrieve.
 *
 * @returns
 * A promise that resolves to the log data.
 *
 * @throws {HTTPException}
 * If the log is not found or if multiple logs are found.
 */
async function getLog(id: string) : Promise<GetLogResponse> {
  const result = await db.select()
    .from(logs)
    .where(eq(logs.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getLogResponse.parse(result[0]);
  return parsed;
}

/**
 * Retrieves the input and output data for a log entry - effectively the
 * "payload" of the inference request and response.
 *
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the log data.
 *
 * @throws {HTTPException}
 * If the log is not found or if multiple logs are found.
 */
async function getLogData(id: string): Promise<GetLogDataResponse> {
  const cacheKey = await createCacheKey('logs:', id);
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const key = `/v1/logs/${id}.json.gz`;
  const buffer = await s3.file(key).bytes();

  const decompressed = Bun.gunzipSync(buffer);
  const jsonString = Buffer.from(decompressed).toString('utf8');
  await redis.set(cacheKey, jsonString, {
    expiration: { type: 'EX', value: 60 * 15 }
  });

  return JSON.parse(jsonString);
}

/**
 * Retrieves a list of models, filtered by the given criteria.
 *
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the log data.
 */
async function listLogs(request: ListLogsRequest) : Promise<ListLogsResponse> {
  // Parse tags from comma-separated string into an object.
  // Expected format is "key1:value1,key2:value2"
  const tagsToFilter: Record<string, string> = {};

  if (request.tags) {
    const pairs = request.tags.split(',');

    for (const pair of pairs) {
      const [key, value] = pair.split(':');

      if (key && value) {
        tagsToFilter[key] = value;
      }
    }
  }

  const conditions = [
    request.model    ? eq(logs.model, request.model) : undefined,
    request.provider ? eq(logs.provider, request.provider) : undefined,
    request.status   ? eq(logs.status, request.status) : undefined,
    request.tags     ? sql`${logs.tags} @> ${tagsToFilter}::jsonb` : undefined,
    request.after_id ? lt(logs.id, request.after_id) : undefined,
  ].filter(x => x !== undefined);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(logs)
    .where(whereClause)
    .orderBy(desc(logs.id))
    .limit(request.limit);

  const nextCursor =
    result.length === request.limit
      ? result[result.length - 1]?.id ?? null
      : null;

  const parsed = Schemas.listLogsResponse.parse({ data: result, next: nextCursor });
  return parsed;
}

/**
 * Creates a new log entry in the database.
 *
 * @param request
 * The request object containing the log data to be created.
 *
 * @returns
 * A promise that resolves to the created log data.
 */
async function createLog(request: CreateLogRequest) : Promise<CreateLogResponse> {
  const result = await db.insert(logs)
    .values(request)
    .returning();

  const parsed = Schemas.createLogResponse.parse(result[0]);
  return parsed;
}

/**
 * Updates an existing log entry in the database.
 *
 * @param id
 * The ID of the log to update.
 *
 * @param payload
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated log data.
 */
async function updateLog(id: string, payload: UpdateLogRequest) : Promise<UpdateLogResponse> {
  const result = await db.update(logs)
    .set(payload)
    .where(eq(logs.id, id))
    .returning();

  const parsed = Schemas.updateLogResponse.parse(result[0]);
  return parsed;
}

export default {
  getLog,
  getLogData,
  listLogs,
  createLog,
  updateLog,
}
