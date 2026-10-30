import { getActorType, parseTags, probe, toPage } from '@repo/core';
import { and, asc, countRows, db, desc, eq, gt, inArray, lt, sql } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getActorId, getCaller, getTraceContext } from '@repo/hono';
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
} from './logs.schemas';
import { flushLogs, type PendingLog, payloadKey, settleLog } from './logs.writer';

export type { PendingLog };

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

type StoredPayloads = Partial<Record<PayloadSide, unknown>>;

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

  const parsed = Schemas.getLog.response.parse({ ...row, actor_type: getActorType(row.actor_id) });
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

  if (!(side === 'request' ? row.has_request : row.has_response)) {
    return err({ code: 'PAYLOAD_NOT_STORED', id, side });
  }

  // Flagged as stored but the object is missing, somehow.
  const payload = (await objectStorage.getJson<StoredPayloads>(payloadKey(row.organization_id, row.id)))?.[side];
  if (payload == null) {
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
      has_request: logs.has_request,
      has_response: logs.has_response,
    })
    .from(logs)
    .where(and(eq(logs.organization_id, caller.organization.id), inArray(logs.id, requested)));

  // Only rows this organization can see, and only those with something stored
  // on the requested side.
  const keysByLogId = new Map<string, string>();
  for (const row of rows) {
    if (side === 'request' ? row.has_request : row.has_response) {
      keysByLogId.set(row.id, payloadKey(caller.organization.id, row.id));
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

  const payloadsByKey = await objectStorage.getManyJson<StoredPayloads>([...keysByLogId.values()]);

  const data: Record<string, unknown> = {};
  for (const [logId, key] of keysByLogId) {
    const payload = payloadsByKey.get(key)?.[side];
    if (payload != null) {
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
    data: data.map((row) => Schemas.getLog.response.parse({ ...row, actor_type: getActorType(row.actor_id) })),
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

  if (row.has_request || row.has_response) {
    await objectStorage.delete(payloadKey(row.organization_id, row.id));
  }

  return ok(undefined); // 204 no content
}

/**
 * Starts a new log for an inference request that is about to be made.
 *
 * @param operation
 * The operation being performed.
 *
 * @param model
 * The model being used for the inference request.
 *
 * @param provider
 * The provider serving the inference request.
 *
 * @param tags
 * The raw ai-log-tags header, if any.
 *
 * @returns
 * The log, to pass to completeLog or failLog.
 */
function startLog(entry: {
  operation: LogRow['operation'];
  model: string;
  provider: string;
  tags?: string;
}): PendingLog {
  const caller = getCaller();

  // Need to generate the id upfront instead of letting the database do it.
  // Object storage and webhook expect it to exist.
  const createdAt = new Date();
  const id = Bun.randomUUIDv7('hex', createdAt);

  // Should be available on every request in practice.
  const trace = getTraceContext();

  return {
    id: id,
    organization_id: caller.organization.id,
    operation: entry.operation,
    model: entry.model,
    provider: entry.provider,
    trace_id: trace?.traceId,
    span_id: trace?.spanId,
    parent_span_id: trace?.parentSpanId,
    actor_id: getActorId(caller),
    tags: parseTags(entry.tags),
    created_at: createdAt,
  };
}

/**
 * Writes a finished inference's log in the background: payloads, then the row.
 *
 * @param log
 * From startLog.
 *
 * @param entry
 * The payloads, which to omit, and the usage to record.
 */
function completeLog(
  log: PendingLog,
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
): void {
  settleLog(
    {
      ...log,
      status: 'complete',
      gateway_cache_hit: entry.gateway_cache_hit ?? false,
      cached_input_tokens: entry.cached_input_tokens ?? null,
      ...(entry.input_tokens != null ? { input_tokens: entry.input_tokens } : {}),
      ...(entry.output_tokens != null ? { output_tokens: entry.output_tokens } : {}),
      ...(entry.input_cost != null ? { input_cost: entry.input_cost } : {}),
      ...(entry.output_cost != null ? { output_cost: entry.output_cost } : {}),
      ...(entry.response_time_ms != null ? { response_time_ms: entry.response_time_ms } : {}),
    },
    {
      ...(entry.omitRequest ? {} : { request: entry.request }),
      ...(entry.omitResponse ? {} : { response: entry.response }),
    },
  );
}

/**
 * Writes the log of an inference that did not finish, with its request.
 *
 * @param log
 * From startLog.
 *
 * @param entry
 * The request payload, and whether to omit it.
 *
 * @param status
 * 'failed', or 'incomplete' when the caller left mid-stream.
 */
function failLog(
  log: PendingLog,
  entry: { request: unknown; omitRequest?: boolean },
  status: 'failed' | 'incomplete' = 'failed',
): void {
  settleLog({ ...log, status }, entry.omitRequest ? {} : { request: entry.request });
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
  flushLogs,
};
