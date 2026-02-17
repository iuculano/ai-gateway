import { HTTPException } from 'hono/http-exception';
import { db, sql, and, eq, desc, lt, asc, gt } from '@repo/drizzle';
import { redis,  } from '@repo/redis';
import { logs } from '@repo/drizzle/schemas';
import { s3 } from '@repo/object-storage';
import Schemas, {
  type GetLogResponse,
  type GetLogDataResponse,
  type ListLogsRequest,
  type ListLogsResponse,
  type CreateLogRequest,
  type CreateLogResponse,
  type UpdateLogRequest,
  type UpdateLogResponse,
  type DeleteLogResponse,
} from './logs.schemas';
import { parseTags, createCacheKey } from '@repo/core';


/**
 * Retrieves a single log by its ID.
 *
 * @param id
 * The ID of the log to retrieve.
 *
 * @returns
 * A promise that resolves to the log data.
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
 * "data" of the inference request and response.
 *
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the log data.
 */
async function getLogData(id: string): Promise<GetLogDataResponse> {
  const cacheKey = await createCacheKey('logs:', id);
  const existing = await redis.get(cacheKey);
  if (existing) {
    return JSON.parse(existing);
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
  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    request.model     ? eq(logs.model, request.model) : undefined,
    request.provider  ? eq(logs.provider, request.provider) : undefined,
    request.status    ? eq(logs.status, request.status) : undefined,
    request.tags      ? sql`${logs.tags} @> ${tagsToFilter}::jsonb` : undefined,
    request.after_id  ? lt(logs.id, request.after_id) : undefined,
    request.before_id ? gt(logs.id, request.before_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  // Say id 20 is the newest log, id 1 is the oldest.
  //
  // Query (after_id):         WHERE id < 15 ORDER BY id DESC LIMIT 3
  // Query returns:            [14, 13, 12] (Correct neighbors)
  // API reversed and returns: [14, 13, 12] (Nothing to change)
  //
  // Query (before_id):        WHERE id > 15 ORDER BY id ASC LIMIT 3
  // Query returns:            [16, 17, 18] (Correct neighbors)
  // API reversed and returns: [18, 17, 16] (Reversed in code)
  //
  // Query (before_id):        WHERE id > 15 ORDER BY id DESC LIMIT 3
  // Query returns:            [20, 19, 18] (Starts from newest in DB)
  // API reversed and returns: [20, 19, 18] (Results in a gap)
  //
  // TLDR:
  // Need to order ASC when using before_id to get correct neighbors then
  // reverse after in code.
  const orderByClause = request.before_id ?
    asc(logs.id) :
    desc(logs.id);

  const result = await db.select()
    .from(logs)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(request.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    // Burn off the extra record.
    result.pop();
  }

  // Order is messed up for before_id, need to reverse it back.
  if (request.before_id) {
    result.reverse();
  }

  const newestId = result[0]?.id ?? null;
  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listLogsResponse.parse({
    data: result,
    meta: {
      newest_id: newestId,
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new log.
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
 * Updates an existing log.
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

  if (result.length === 0) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.updateLogResponse.parse(result[0]);
  return parsed;
}

/**
 * Deletes an existing log.
 *
 * @param id
 * The ID of the log to delete.
 *
 * @returns
 * A promise that resolves to nothing.
 */
async function deleteLog(id: string) : Promise<DeleteLogResponse> {
  const result = await db.delete(logs)
    .where(eq(logs.id, id))
    .returning();

  if (result.length === 0) {
    throw new HTTPException(404);
  }

  return null as DeleteLogResponse;
}

export default {
  getLog,
  getLogData,
  listLogs,
  createLog,
  updateLog,
  deleteLog,
}
