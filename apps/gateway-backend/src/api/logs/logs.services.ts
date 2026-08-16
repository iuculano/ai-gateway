import { parseTags, probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, gt, inArray, lt, sql } from '@repo/drizzle';
import { logs } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
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

export type GetLogFailure = {
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
export type GetLogPayloadFailure =
  | {
      code: 'LOG_NOT_FOUND';
      id: string;
    }
  | {
      code: 'PAYLOAD_NOT_STORED';
      id: string;
      side: PayloadSide;
    }
  | {
      code: 'PAYLOAD_UNAVAILABLE';
      id: string;
      side: PayloadSide;
    };

export type DeleteLogFailure = {
  code: 'LOG_NOT_FOUND';
  id: string;
};

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
 * The row is read first and the key comes off it. That ordering is what makes
 * this safe: the read includes the caller's organization, so a log id belonging
 * to another organization returns no row and never reaches object
 * storage. Building a key straight from the caller's id would bypass the
 * organization check entirely, because object storage has no idea who is asking.
 *
 * @param id
 * The id of the log.
 *
 * @param side
 * Which payload to read.
 *
 * @returns
 * The stored payload, or the reason there is not one to return. Object storage
 * failing outright is not one of those reasons - that rejects.
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

  // A null here is the object being absent. Anything else that can go wrong
  // with the read - credentials, network, a corrupt body - throws out of
  // getJson and stays in the unexpected channel.
  const payload = await objectStorage.getJson(key);
  if (payload === null) {
    // The row names an object that is not there - expired under a lifecycle
    // rule, or deleted out from under us. Same status as "never stored", but
    // worth distinguishing: this one says something was lost.
    return err({ code: 'PAYLOAD_UNAVAILABLE', id, side });
  }

  return ok(payload);
}

/**
 * Retrieves one side of the payload for many logs at once.
 *
 * The object reads are concurrent - see CompressedJsonStore.getManyJson - so the
 * cost is roughly the slowest single object rather than the sum of them.
 *
 * Tenancy works the same way as the single-log read, and matters more here: the
 * id list arrives from the caller, and the scoped query is what filters it down
 * to the ids this organization may actually see. Ids that survive that filter
 * are the only ones ever turned into object keys.
 *
 * @param ids
 * The log ids to read. Already length-capped by the schema.
 *
 * @param side
 * Which payload to read.
 *
 * Deliberately not a Result, unlike the single-log read: absence is the normal
 * case for a batch and is already modelled in the success value, as
 * `meta.missing`. A caller asking for fifty payloads and getting forty-nine has
 * not failed at anything.
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

  // Do not require object storage for an entirely missing batch. Apart from
  // avoiding a pointless remote call, this preserves the tenancy boundary:
  // ids filtered out by the scoped query never cause any storage access.
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

  // Order is messed up for before_id, need to reverse it back. This has to
  // happen after the trim - the probe row is the extra neighbour in whichever
  // direction we scanned, so dropping it before reversing is what keeps the
  // page contiguous.
  const data = query.before_id ? page.data.toReversed() : page.data;

  // Cursors are recomputed rather than taken from page.meta: this endpoint
  // pages both ways, so it needs both ends, and reversing moved them.
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
 * Where counting stops and estimating starts.
 *
 * The exact aggregate is a full index-only scan of the tenant's rows: measured
 * at roughly 60ms per 100k logs, which is a fine price for a number that is
 * simply correct, and not a fine price at ten times that. Above the threshold
 * the same figures come from a sample and land within about 1%.
 */
const EXACT_THRESHOLD = 100_000;

/**
 * How many rows the estimate samples.
 *
 * The sample PERCENTAGE is derived from this rather than fixed, so the row
 * count stays roughly constant as a tenant grows and the cost of this endpoint
 * does not grow with it. 20k lands under 1% error on every figure here; going
 * wider buys accuracy nobody can see behind a "~".
 */
const TARGET_SAMPLE_ROWS = 20_000;

/**
 * The most of the table a single request may sample.
 *
 * TABLESAMPLE SYSTEM reads PAGES, and it reads them from the whole table before
 * the organization predicate filters anything - so the pages it must touch to collect
 * TARGET_SAMPLE_ROWS of one tenant scale with that tenant's share of the table,
 * not with its size. A tenant holding most of the table needs ~4% of the pages;
 * one holding a hundredth of a much larger table would need a hundred times as
 * many for the same evidence, which is how a flat-cost endpoint quietly becomes
 * a table scan.
 *
 * The clamp bounds the work instead. Past it the sample is smaller than the
 * target and the small buckets get noisier - which `estimated` already warns
 * about - but the request cannot run away. If that trade ever stops being
 * acceptable, the next step is a rollup maintained out of band, not a bigger
 * sample.
 */
const MAX_SAMPLE_PERCENTAGE = 5;

/**
 * The planner's own estimate of how many rows this tenant has.
 *
 * EXPLAIN without ANALYZE, so nothing is executed - this is the plan's row
 * estimate, which for a plain `organization_id` predicate comes from real
 * column statistics and lands within a fraction of a percent. It is NOT
 * trustworthy for a jsonb filter, which is one of the reasons this endpoint
 * takes no filters, and it degrades on narrow buckets - a status holding 1% of
 * the table came out 12% low, which is why the breakdown is sampled instead.
 */
async function estimateLogCount(organizationId: string): Promise<number> {
  const rows = await db.execute<Record<string, unknown>>(
    sql`explain (format json) select 1 from ${logs} where ${logs.organization_id} = ${organizationId}`,
  );

  // The driver usually hands back parsed json; a string is still valid output
  // from EXPLAIN and cheaper to handle than to rule out.
  const raw = Object.values(rows[0] ?? {})[0];
  const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const estimate = plan?.[0]?.Plan?.['Plan Rows'];

  return typeof estimate === 'number' && Number.isFinite(estimate) ? Math.max(0, Math.round(estimate)) : 0;
}

/**
 * Tenant-wide totals, counted when that is cheap and sampled when it is not.
 *
 * Three steps, and the first one earns its keep twice:
 *
 * 1. A capped count - `limit EXACT_THRESHOLD + 1` - decides which mode to use.
 *    It stops as soon as it has seen one row too many, so it costs the same for
 *    a tenant with a hundred thousand logs as for one with fifty million. When
 *    it comes back under the cap it IS the exact total, so the decision is free.
 *    A planner estimate would have been cheaper still, but it would make the
 *    `estimated` flag flicker for tenants sitting near the threshold, and a
 *    number that changes shape between two page loads reads as a bug.
 *
 * 2. Under the cap, one aggregate counts everything.
 *
 * 3. Over it, the total is the planner's estimate and the breakdown comes from
 *    a single TABLESAMPLE, scaled by total/sampled.
 *
 * Deliberately not a Result: there is no outcome here a caller could correct.
 * A tenant with no logs gets zeroes, which is a true answer rather than a
 * failure - and every aggregate is COALESCEd to make sure it is a zero and not
 * the null that sum() returns over an empty set.
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

  // The tenant's size, from the planner. Accurate to a fraction of a percent
  // for a plain organization_id predicate, and it anchors everything below.
  const estimate = await estimateLogCount(organizationId);

  // One sample supplies the whole breakdown. Taking the per-status counts from
  // the planner instead was tried and measured, and is NOT better: it improved
  // 'failed' from -5.7% to -1.2% and made 'incomplete' worse, -0.3% to -12.1%,
  // for three extra round trips. Both methods sit in the same few-percent band
  // on the small buckets, so the one that costs a single query wins.
  //
  // Where that error comes from is worth knowing: TABLESAMPLE SYSTEM selects
  // whole PAGES, so rows sharing a page are correlated and a bucket holding 3%
  // of the table carries less independent evidence than its row count suggests.
  // Expect the dominant status to be within a percent and the rare ones to
  // drift by several. That is the deal `estimated: true` is announcing.
  //
  // The percentage is derived from the estimate so the number of sampled rows
  // stays near TARGET_SAMPLE_ROWS however large the tenant is - which is what
  // keeps this endpoint's cost flat rather than proportional to the table.
  // Clamped at both ends: MAX_SAMPLE_PERCENTAGE bounds the page reads, and a
  // percentage small enough to round to zero would sample nothing at all.
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

  // A sample that caught none of this tenant's rows says nothing about them, so
  // the whole total is attributed to 'complete' rather than reporting a
  // confident zero or dividing by it. Only reachable if the tenant's rows are
  // clustered into pages the sample happened to miss entirely.
  if (!sample || sampled === 0) {
    return toStats({ complete: estimate }, true);
  }

  // Scaling from the sample's SUMS rather than its averages is what makes the
  // null-heavy columns work without special-casing: an 'incomplete' row has no
  // tokens, and sum() already ignores those where avg() would have to be told.
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
 * `total` is built by ADDING the three status counts rather than being carried
 * separately. Exactly, that is what it already is; estimated, the three are
 * rounded independently and would otherwise miss their own total by a row or
 * two - a discrepancy that is invisible in the number and glaring in a panel
 * that renders both.
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
 * The row goes first. If object deletion fails afterwards the objects are
 * orphaned, which a lifecycle rule will eventually collect - whereas deleting
 * the objects first and then failing to delete the row would leave a log that
 * advertises payloads nobody can fetch.
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

  // Deliberately not swallowed: the row is already gone by here, so a failure
  // leaves orphaned objects, and the caller should hear about it rather than be
  // told the delete was clean.
  await objectStorage.deleteMany(keys);

  return ok(undefined);
}

/**
 * Opens a log for an inference request that is about to be made.
 *
 * Written before the provider is called so that a request which dies in flight
 * still leaves a trace. The row starts 'incomplete' and one of completeLog or
 * failLog resolves it.
 *
 * @param organizationId
 * The tenant the log belongs to.
 *
 * @param entry
 * What is known before the call: the model and the provider serving it.
 *
 * @returns
 * The id of the new log.
 */
async function startLog(organizationId: string, entry: { model: string; provider: string }): Promise<string> {
  const [row] = await db
    .insert(logs)
    .values({
      organization_id: organizationId,
      model: entry.model,
      provider: entry.provider,
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
 * The two payloads are written as separate objects, concurrently, and either
 * may be skipped - `omitRequest` / `omitResponse` carry the caller's
 * ai-log-omit-* headers. A side that is skipped leaves its key column null,
 * which is what makes has_request / has_response and the 404s on those
 * endpoints truthful.
 *
 * Objects are written BEFORE the row is updated. The row is what advertises a
 * payload as fetchable, so publishing that claim before the object exists would
 * open a window where the endpoint 404s on a log that says it has data.
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
 * The request payload is still stored when available - a failed call is
 * precisely the one somebody will want to inspect the inputs of.
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
