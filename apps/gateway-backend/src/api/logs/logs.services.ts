import { parseTags, probe, toPage } from '@repo/core';
import { and, asc, countRows, db, desc, eq, gt, inArray, lt, sql } from '@repo/drizzle';
import { logs } from '@repo/drizzle/schemas';
import { getCaller, getTraceContext } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type BatchResponse,
  type CountLogsResponse,
  type DeleteLogResponse,
  type GetLogPayloadResponse,
  type GetLogResponse,
  type ListLogsQuery,
  type ListLogsResponse,
  type LogShape,
} from './logs.schemas';

// What type of payload we're attempting to retrieve.
export type PayloadSide = 'request' | 'response';

// The underlying error definitions.
type LogNotFoundFailure = {
  code: 'LOG_NOT_FOUND';
  id: string;
};

type PayloadNotStoredFailure = {
  code: 'PAYLOAD_NOT_STORED';
  id: string;
  side: PayloadSide;
};

type PayloadUnavailableFailure = {
  code: 'PAYLOAD_UNAVAILABLE';
  id: string;
  side: PayloadSide;
};

// The public service failure unions.
export type GetLogFailure = LogNotFoundFailure;
export type GetLogPayloadFailure = LogNotFoundFailure | PayloadNotStoredFailure | PayloadUnavailableFailure;
export type DeleteLogFailure = LogNotFoundFailure;

function objectKey(organizationId: string, logId: string, side: PayloadSide): string {
  return `logs/${organizationId}/${logId}/${side}.json.zst`;
}

function toLogShape(row: typeof logs.$inferSelect): LogShape {
  return Schemas.getLog.response.parse({
    ...row,
    has_request: row.request_object_reference !== null,
    has_response: row.response_object_reference !== null,
  });
}

/**
 * Retrieves a single log by its id.
 *
 * @param id
 * The id of the log to retrieve.
 */
async function getLog(id: string): Promise<Result<GetLogResponse, GetLogFailure>> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(logs)
    .where(and(
      eq(logs.organization_id, caller.organization.id),
      eq(logs.id, id)
    ));

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  const parsed = toLogShape(row);
  return ok(parsed);
}

/**
 * Retrieves one side of a log's stored payload.
 *
 * @param id
 * The id of the log.
 *
 * @param side
 * Which payload to read.
 */
async function getLogPayload(
  id: string,
  side: PayloadSide,
): Promise<Result<GetLogPayloadResponse, GetLogPayloadFailure>> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(logs)
    .where(and(
      eq(logs.organization_id, caller.organization.id),
      eq(logs.id, id)
    ));

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  const key = side === 'request' ? row.request_object_reference : row.response_object_reference;
  if (!key) {
    return err({ code: 'PAYLOAD_NOT_STORED', id, side });
  }

  // Have a reference saved but the object is missing, somehow.
  const payload = await objectStorage.getJson(key);
  if (payload === null) {
    return err({ code: 'PAYLOAD_UNAVAILABLE', id, side });
  }

  return ok(payload);
}

/**
 * Retrieves one side of the payload for many logs at once.
 *
 * @param ids
 * The log ids to read.
 *
 * @param side
 * Which payload to read.
 */
async function getLogPayloadBatch(ids: string[], side: PayloadSide): Promise<BatchResponse> {
  const caller = getCaller();
  const requested = [...new Set(ids)];

  const rows = await db
    .select({
      id: logs.id,
      request_object_reference: logs.request_object_reference,
      response_object_reference: logs.response_object_reference,
    })
    .from(logs)
    .where(and(eq(logs.organization_id, caller.organization.id), inArray(logs.id, requested)));

  // Only rows this organization can see, and only those with something stored
  // on the requested side.
  const keysByLogId = new Map<string, string>();
  for (const row of rows) {
    const key = side === 'request' ? row.request_object_reference : row.response_object_reference;
    if (key) {
      keysByLogId.set(row.id, key);
    }
  }

  // Preserve the tenancy boundary: ids rejected by the scoped query never reach storage.
  if (keysByLogId.size === 0) {
    return Schemas.batch.response.parse({
      data: {},
      meta: {
        requested: requested.length,
        returned: 0,
        missing: requested,
      },
    });
  }

  const payloadsByKey = await objectStorage.getManyJson([...keysByLogId.values()]);

  const data: Record<string, unknown> = {};
  for (const [logId, key] of keysByLogId) {
    const payload = payloadsByKey.get(key);
    if (payload !== undefined) {
      data[logId] = payload;
    }
  }

  const returnedIds = new Set(Object.keys(data));

  return Schemas.batch.response.parse({
    data: data,
    meta: {
      requested: requested.length,
      returned: returnedIds.size,
      missing: requested.filter((id) => !returnedIds.has(id)),
    },
  });
}

/**
 * Retrieves a list of logs, filtered by the given criteria.
 *
 * @param query
 * The filter criteria.
 */
async function listLogs(query: ListLogsQuery): Promise<ListLogsResponse> {
  const caller = getCaller();

  // Expected format is "key1:value1,key2:value2"
  const tagsToFilter = parseTags(query.tags);

  const conditions = [
    eq(logs.organization_id, caller.organization.id),
    query.model ? eq(logs.model, query.model) : undefined,
    query.provider ? eq(logs.provider, query.provider) : undefined,
    query.status ? eq(logs.status, query.status) : undefined,
    query.trace_id ? eq(logs.trace_id, query.trace_id) : undefined,
    query.tags ? sql`${logs.tags} @> ${tagsToFilter}::jsonb` : undefined,
    query.after_id ? lt(logs.id, query.after_id) : undefined,
    query.before_id ? gt(logs.id, query.before_id) : undefined,
  ];

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
  const orderByClause = query.before_id ? asc(logs.id) : desc(logs.id);

  const rows = await db
    .select()
    .from(logs)
    .where(and(...conditions))
    .orderBy(orderByClause)
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);

  // Trim the probe row before reversing to keep the page contiguous.
  const data = query.before_id ? page.data.toReversed() : page.data;

  // Recompute both cursors after the possible reversal.
  return Schemas.listLogs.response.parse({
    data: data.map(toLogShape),
    meta: {
      newest_id: data.at(0)?.id ?? null,
      oldest_id: data.at(-1)?.id ?? null,
      more_data: page.meta.more_data,
    },
  });
}

async function countLogs(): Promise<CountLogsResponse> {
  const caller = getCaller();

  const by_status = { complete: 0, failed: 0, incomplete: 0 };
  let estimated = false;

  // Ouch, this can scan 3x for an upwards of 300,000 rows!!
  // TODO figure out a better way to handle this - maybe cache the counts?
  for (const status of ['complete', 'failed', 'incomplete'] as const) {
    // biome-ignore format: looks nicer
    const result = await countRows(db, logs, {
      where: and(
        eq(logs.organization_id, caller.organization.id),
        eq(logs.status, status)
      ),
    });

    by_status[status] = result.count;
    estimated = estimated || result.estimated;
  }

  return Schemas.countLogs.response.parse({
    total: by_status.complete + by_status.failed + by_status.incomplete,
    estimated,
    by_status,
  });
}

/**
 * Deletes a log and both of its stored payloads.
 *
 * @param id
 * The id of the log to delete.
 */
async function deleteLog(id: string): Promise<Result<DeleteLogResponse, DeleteLogFailure>> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const [row] = await db
    .delete(logs)
    .where(and(
      eq(logs.organization_id, caller.organization.id),
      eq(logs.id, id)
    ))
    .returning();

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  const keys = [row.request_object_reference, row.response_object_reference].filter((key) => key !== null);
  await objectStorage.deleteMany(keys);

  return ok(undefined); // 204 no content
}

/**
 * Opens a log for an inference request that is about to be made.
 *
 * The row is created as incomplete before the provider call so failures in
 * flight remain observable.
 *
 * @param organizationId
 * The tenant the log belongs to.
 *
 * @param entry
 * What is known before the call: the model, the provider serving it, and the
 * actor spending on it.
 *
 * @returns
 * The id of the new log.
 */
async function startLog(
  organizationId: string,
  entry: {
    model: string;
    provider: string;
    tags?: Record<string, string>;
    actor_type: 'user' | 'api_key';
    actor_id: string;
  },
): Promise<string> {
  const trace = getTraceContext();
  const [row] = await db
    .insert(logs)
    .values({
      organization_id: organizationId,
      model: entry.model,
      provider: entry.provider,
      ...(trace
        ? {
            trace_id: trace.traceId,
            span_id: trace.spanId,
            ...(trace.parentSpanId ? { parent_span_id: trace.parentSpanId } : {}),
          }
        : {}),
      // Required attribution ensures usage budgets cannot be bypassed.
      actor_type: entry.actor_type,
      actor_id: entry.actor_id,
      // Capture tags before provider work because webhook fan-out reads them later.
      tags: entry.tags,
      status: 'incomplete',
    })
    .returning({ id: logs.id });

  if (!row) {
    throw new Error('Failed to open log');
  }

  return row.id;
}

/**
 * Stores the payloads for a finished inference and marks the log complete.
 *
 * @param organizationId
 * The tenant the log belongs to.
 *
 * @param id
 * The log to complete, from startLog.
 *
 * @param entry
 * The payloads and the usage figures to record.
 */
async function completeLog(
  organizationId: string,
  id: string,
  entry: {
    request: unknown;
    response: unknown;
    omitRequest?: boolean;
    omitResponse?: boolean;
    gateway_cache_hit?: boolean;
    cached_input_tokens?: number | null;
    input_tokens?: number;
    output_tokens?: number;
    input_cost?: number;
    output_cost?: number;
    response_time_ms?: number;
  },
): Promise<void> {
  const requestKey = entry.omitRequest ? null : objectKey(organizationId, id, 'request');
  const responseKey = entry.omitResponse ? null : objectKey(organizationId, id, 'response');

  await Promise.all([
    requestKey ? objectStorage.putJson(requestKey, entry.request) : Promise.resolve(),
    responseKey ? objectStorage.putJson(responseKey, entry.response) : Promise.resolve(),
  ]);

  // biome-ignore format: looks nicer
  await db
    .update(logs)
    .set({
      status: 'complete',
      gateway_cache_hit: entry.gateway_cache_hit ?? false,
      cached_input_tokens: entry.cached_input_tokens ?? null,
      request_object_reference: requestKey,
      response_object_reference: responseKey,
      ...(entry.input_tokens != null ? { input_tokens: entry.input_tokens } : {}),
      ...(entry.output_tokens != null ? { output_tokens: entry.output_tokens } : {}),
      ...(entry.input_cost != null ? { input_cost: entry.input_cost } : {}),
      ...(entry.output_cost != null ? { output_cost: entry.output_cost } : {}),
      ...(entry.response_time_ms != null ? { response_time_ms: entry.response_time_ms } : {}),
    })
    .where(and(
      eq(logs.organization_id, organizationId),
      eq(logs.id, id)
    ));
}

/**
 * Marks a log failed.
 *
 * @param organizationId
 * The tenant the log belongs to.
 *
 * @param id
 * The log to fail, from startLog.
 *
 * @param entry
 * The request payload and its storage-omission control.
 */
async function failLog(
  organizationId: string,
  id: string,
  entry: { request: unknown; omitRequest?: boolean },
): Promise<void> {
  const key = entry.omitRequest ? null : objectKey(organizationId, id, 'request');
  if (key) {
    await objectStorage.putJson(key, entry.request);
  }

  // biome-ignore format: looks nicer
  await db
    .update(logs)
    .set({
      status: 'failed',
      ...(key ? { request_object_reference: key } : {}),
    })
    .where(and(
      eq(logs.organization_id, organizationId),
      eq(logs.id, id)
    ));
}

export default {
  getLog,
  getLogPayload,
  getLogPayloadBatch,
  listLogs,
  countLogs,
  deleteLog,

  startLog,
  completeLog,
  failLog,
};
