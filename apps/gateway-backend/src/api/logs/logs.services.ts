import { parseTags, probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, gt, inArray, lt, sql } from '@repo/drizzle';
import { logs } from '@repo/drizzle/schemas';
import { getCaller, getTraceContext } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type BatchResponse,
  type DeleteLogResponse,
  type GetLogPayloadResponse,
  type GetLogResponse,
  type ListLogsQuery,
  type ListLogsResponse,
  type LogShape,
  type LogStatsResponse,
} from './logs.schemas';

/** Which of the two payloads an operation is about. */
export type PayloadSide = 'request' | 'response';

// The underlying error definitions.
type LogNotFoundFailure = {
  code: 'LOG_NOT_FOUND';
  id: string;
};

/**
 * Three ways a payload read can come back empty, kept apart on purpose.
 *
 * They all answer 404, but with different messages, and the difference is worth
 * something to whoever is reading it: a log that was never given a payload on
 * that side is a normal state that will never change, while one whose object
 * has gone means the row still advertises something that a lifecycle rule or a
 * stray delete has since taken away. Collapsing them would lose that.
 *
 * `side` travels with the failure because the message names it, and the handler
 * has no other way to know which of the two endpoints it is answering for.
 */
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

/**
 * Where a payload lives.
 *
 * Organization first, so a bucket lifecycle rule or a tenant-wide purge is a
 * prefix operation rather than a scan. The key is stored on the row rather than
 * recomputed at read time, so this layout can change without a migration -
 * existing rows keep pointing at where their objects actually are.
 */
function objectKey(organizationId: string, logId: string, side: PayloadSide): string {
  return `logs/${organizationId}/${logId}/${side}.json.zst`;
}

/**
 * Adds the derived has_request / has_response flags and drops the internal
 * key columns.
 */
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
  const [row] = await db
    .select()
    .from(logs)
    .where(and(eq(logs.organization_id, caller.organization.id), eq(logs.id, id)));

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  return ok(toLogShape(row));
}

/**
 * Retrieves one side of a log's stored payload.
 *
 * The tenant-scoped row is resolved before its object key, so object storage is
 * never queried for another tenant's log.
 *
 * @param id
 * The id of the log.
 *
 * @param side
 * Which payload to read.
 *
 * @returns
 * The stored payload or the expected reason it is unavailable. Storage failures
 * still reject.
 */
async function getLogPayload(
  id: string,
  side: PayloadSide,
): Promise<Result<GetLogPayloadResponse, GetLogPayloadFailure>> {
  const caller = getCaller();
  const [row] = await db
    .select()
    .from(logs)
    .where(and(eq(logs.organization_id, caller.organization.id), eq(logs.id, id)));

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  const key = side === 'request' ? row.request_object_reference : row.response_object_reference;
  if (!key) {
    return err({ code: 'PAYLOAD_NOT_STORED', id, side });
  }

  // Null means absent - transport and decoding failures are unexpected errors.
  const payload = await objectStorage.getJson(key);
  if (payload === null) {
    // Distinguish a missing referenced object from a payload that was never
    // stored.
    return err({ code: 'PAYLOAD_UNAVAILABLE', id, side });
  }

  return ok(payload);
}

/**
 * Retrieves one side of the payload for many logs at once.
 *
 * Reads are concurrent, and absent payloads are reported in `meta.missing` rather than
 * failing the batch.
 *
 * @param ids
 * The log ids to read. Already length-capped by the schema.
 *
 * @param side
 * Which payload to read.
 *
 * @returns
 * The payloads that resolved, keyed by log id, plus the ids that did not.
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
 * Deliberately not a Result: an empty page is a page, and there is no outcome
 * here the caller could correct.
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

/**
 * Above this size, statistics use a bounded sample instead of scanning every
 * tenant row.
 */
const EXACT_THRESHOLD = 100_000;

/**
 * Target sample size keeps estimated-query work stable as tenants grow.
 */
const TARGET_SAMPLE_ROWS = 20_000;

/**
 * Caps page reads because `TABLESAMPLE` runs before the tenant predicate; small
 * tenants in a shared table may therefore receive a noisier sample.
 */
const MAX_SAMPLE_PERCENTAGE = 5;

/**
 * The planner's own estimate of how many rows this tenant has.
 *
 * `EXPLAIN` without `ANALYZE` avoids executing the count. The estimate is used
 * only for the tenant predicate; narrower breakdowns come from the sample.
 */
async function estimateLogCount(organizationId: string): Promise<number> {
  const rows = await db.execute<Record<string, unknown>>(
    sql`explain (format json) select 1 from ${logs} where ${logs.organization_id} = ${organizationId}`,
  );

  // Drivers may return EXPLAIN JSON either parsed or serialized.
  const raw = Object.values(rows[0] ?? {})[0];
  const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const estimate = plan?.[0]?.Plan?.['Plan Rows'];

  return typeof estimate === 'number' && Number.isFinite(estimate) ? Math.max(0, Math.round(estimate)) : 0;
}

/**
 * Tenant-wide totals, counted when that is cheap and sampled when it is not.
 *
 * A capped count selects the exact or estimated path without scanning beyond
 * the threshold. Large tenants use the planner for the total and one bounded
 * sample for all breakdowns; empty tenants return zeroes.
 */
async function getLogStats(): Promise<LogStatsResponse> {
  const organizationId = getCaller().organization.id;
  const [capped] = await db.execute<{ total: number }>(
    sql`select count(*)::int as total
        from (
          select 1
          from ${logs}
          where ${logs.organization_id} = ${organizationId}
          limit ${EXACT_THRESHOLD + 1}
        ) t`,
  );

  const cappedTotal = capped?.total ?? 0;

  if (cappedTotal <= EXACT_THRESHOLD) {
    const [row] = await db.execute<Record<string, string | number>>(sql`
      select
        count(*) filter (where ${logs.status} = 'complete')::int   as complete,
        count(*) filter (where ${logs.status} = 'failed')::int     as failed,
        count(*) filter (where ${logs.status} = 'incomplete')::int as incomplete,
        coalesce(sum(${logs.input_tokens}), 0)::bigint             as input_tokens,
        coalesce(sum(${logs.output_tokens}), 0)::bigint            as output_tokens,
        coalesce(sum(${logs.input_cost}), 0)                       as input_cost,
        coalesce(sum(${logs.output_cost}), 0)                      as output_cost
      from ${logs}
      where ${logs.organization_id} = ${organizationId}
    `);

    return toStats(row ?? {}, false);
  }

  const estimate = await estimateLogCount(organizationId);

  // One page-level sample supplies every breakdown. Derive its percentage from
  // the estimate, then clamp it to bound work and avoid rounding to an empty sample.
  const percentage = Math.min(
    MAX_SAMPLE_PERCENTAGE,
    Math.max(0.01, (100 * TARGET_SAMPLE_ROWS) / Math.max(estimate, 1)),
  );

  const [sample] = await db.execute<Record<string, string | number>>(sql`
    select
      count(*)::int                                              as sampled,
      count(*) filter (where ${logs.status} = 'complete')::int    as complete,
      count(*) filter (where ${logs.status} = 'failed')::int      as failed,
      count(*) filter (where ${logs.status} = 'incomplete')::int  as incomplete,
      coalesce(sum(${logs.input_tokens}), 0)::bigint              as input_tokens,
      coalesce(sum(${logs.output_tokens}), 0)::bigint             as output_tokens,
      coalesce(sum(${logs.input_cost}), 0)                        as input_cost,
      coalesce(sum(${logs.output_cost}), 0)                       as output_cost
    from ${logs} tablesample system (${percentage})
    where ${logs.organization_id} = ${organizationId}
  `);

  const sampled = Number(sample?.sampled ?? 0);

  // A page sample can miss a tenant entirely; preserve the estimated total
  // instead of reporting a confident zero or dividing by it.
  if (!sample || sampled === 0) {
    return toStats({ complete: estimate }, true);
  }

  // Scale sums so null token and cost values need no separate treatment.
  const scale = estimate / sampled;

  return toStats(
    {
      complete: Math.round(Number(sample.complete) * scale),
      failed: Math.round(Number(sample.failed) * scale),
      incomplete: Math.round(Number(sample.incomplete) * scale),
      input_tokens: Math.round(Number(sample.input_tokens) * scale),
      output_tokens: Math.round(Number(sample.output_tokens) * scale),
      input_cost: Number(sample.input_cost) * scale,
      output_cost: Number(sample.output_cost) * scale,
    },
    true,
  );
}

/**
 * Assembles the response from either branch's raw figures.
 *
 * Deriving `total` from the rounded status counts keeps estimated totals
 * consistent with the visible breakdown.
 */
function toStats(row: Record<string, string | number | undefined>, estimated: boolean): LogStatsResponse {
  const complete = Number(row.complete ?? 0);
  const failed = Number(row.failed ?? 0);
  const incomplete = Number(row.incomplete ?? 0);

  const inputTokens = Number(row.input_tokens ?? 0);
  const outputTokens = Number(row.output_tokens ?? 0);

  const inputCost = Number(row.input_cost ?? 0);
  const outputCost = Number(row.output_cost ?? 0);

  return Schemas.stats.response.parse({
    total: complete + failed + incomplete,
    estimated: estimated,
    by_status: { complete, failed, incomplete },
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    cost: { input: inputCost, output: outputCost, total: inputCost + outputCost },
  });
}

/**
 * Deletes a log and both of its stored payloads.
 *
 * The row is deleted first so a later storage failure leaves lifecycle-cleanable
 * orphans rather than references to missing payloads.
 *
 * @param id
 * The id of the log to delete.
 */
async function deleteLog(id: string): Promise<Result<DeleteLogResponse, DeleteLogFailure>> {
  const caller = getCaller();
  const [row] = await db
    .delete(logs)
    .where(and(eq(logs.organization_id, caller.organization.id), eq(logs.id, id)))
    .returning();

  if (!row) {
    return err({ code: 'LOG_NOT_FOUND', id });
  }

  const keys = [row.request_object_reference, row.response_object_reference].filter((key) => key !== null);

  // Surface storage failures because they leave orphaned objects after row deletion.
  await objectStorage.deleteMany(keys);

  return ok(undefined);
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
 * Non-omitted payloads are written concurrently before their references are
 * published on the row, preventing a completed log from advertising an object
 * that is not yet readable.
 *
 * @param organizationId
 * The tenant the log belongs to. Passed explicitly - see startLog.
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
    request?: unknown;
    response?: unknown;
    omitRequest?: boolean;
    omitResponse?: boolean;
    input_tokens?: number;
    output_tokens?: number;
    input_cost?: number;
    output_cost?: number;
    response_time_ms?: number;
  },
): Promise<void> {
  const writeRequest = entry.request !== undefined && !entry.omitRequest;
  const writeResponse = entry.response !== undefined && !entry.omitResponse;

  const requestKey = writeRequest ? objectKey(organizationId, id, 'request') : null;
  const responseKey = writeResponse ? objectKey(organizationId, id, 'response') : null;

  await Promise.all([
    requestKey ? objectStorage.putJson(requestKey, entry.request) : Promise.resolve(),
    responseKey ? objectStorage.putJson(responseKey, entry.response) : Promise.resolve(),
  ]);

  await db
    .update(logs)
    .set({
      status: 'complete',
      request_object_reference: requestKey,
      response_object_reference: responseKey,
      ...(entry.input_tokens != null ? { input_tokens: entry.input_tokens } : {}),
      ...(entry.output_tokens != null ? { output_tokens: entry.output_tokens } : {}),
      ...(entry.input_cost != null ? { input_cost: entry.input_cost } : {}),
      ...(entry.output_cost != null ? { output_cost: entry.output_cost } : {}),
      ...(entry.response_time_ms != null ? { response_time_ms: entry.response_time_ms } : {}),
    })
    .where(and(eq(logs.organization_id, organizationId), eq(logs.id, id)));
}

/**
 * Marks a log failed.
 *
 * The request payload remains useful for diagnosing the failure and is retained
 * unless explicitly omitted.
 *
 * @param organizationId
 * The tenant the log belongs to. Passed explicitly - see startLog.
 *
 * @param id
 * The log to fail, from startLog.
 *
 * @param entry
 * The request payload, if there is one worth keeping.
 */
async function failLog(
  organizationId: string,
  id: string,
  entry: { request?: unknown; omitRequest?: boolean } = {},
): Promise<void> {
  const writeRequest = entry.request !== undefined && !entry.omitRequest;
  const requestKey = writeRequest ? objectKey(organizationId, id, 'request') : null;

  if (requestKey) {
    await objectStorage.putJson(requestKey, entry.request);
  }

  await db
    .update(logs)
    .set({
      status: 'failed',
      ...(requestKey ? { request_object_reference: requestKey } : {}),
    })
    .where(and(eq(logs.organization_id, organizationId), eq(logs.id, id)));
}

export default {
  getLog,
  getLogPayload,
  getLogPayloadBatch,
  listLogs,
  getLogStats,
  deleteLog,

  // Ingestion. Not reachable over HTTP - see the note in logs.routes.ts.
  startLog,
  completeLog,
  failLog,
};
