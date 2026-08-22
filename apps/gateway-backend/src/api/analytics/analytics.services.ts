import { createCacheKey, parseTags } from '@repo/core';
import { and, db, eq, gte, lte, max, min, sql } from '@repo/drizzle';
import { analyticsHourly, apiKeys, logs, users } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
import { redis } from '@repo/redis';
import type { SQL } from 'drizzle-orm';
import Schemas, {
  type AnalyticsBody,
  type AnalyticsResponse,
  type AnalyticsSeriesBody,
  type AnalyticsSeriesResponse,
} from './analytics.schemas';

/**
 * Queries the analytics data based on the provided parameters.
 *
 * TODO ADD ROLLUPS SO THIS ISN'T AS AWFUL.
 *
 * @param request
 * The parameters for querying analytics data.
 *
 * @returns
 * The analytics response. This deliberately stays a plain Promise rather than
 * Result: an empty aggregation is a valid response, so there is no expected
 * refusal for a caller to act on. Infrastructure and schema failures reject.
 */
async function queryAnalytics(request: AnalyticsBody): Promise<AnalyticsResponse> {
  const organizationId = getCaller().organization.id;

  // This is a relatively expensive query!
  const cacheKey = await createCacheKey('analytics:', { organization_id: organizationId, ...request });
  const existing = await redis.get(cacheKey);
  if (existing) {
    return JSON.parse(existing);
  }

  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    eq(logs.organization_id, organizationId),
    request.start_date ? gte(logs.created_at, new Date(request.start_date)) : undefined,
    request.end_date ? lte(logs.created_at, new Date(request.end_date)) : undefined,
    request.model ? eq(logs.model, request.model) : undefined,
    request.provider ? eq(logs.provider, request.provider) : undefined,
    request.status ? eq(logs.status, request.status) : undefined,
    request.tags ? sql`${logs.tags} @> ${tagsToFilter}::jsonb` : undefined,
  ];

  const query = db
    .select({
      total_logs: sql<number>`COUNT(*)`.mapWith(Number),

      // 'complete', not 'success'. The column's enum is
      // incomplete | complete | failed, so the old comparison against 'success'
      // matched nothing: successful_logs was always 0 and error_logs was always
      // the total. The binary split is kept as it was - anything not complete
      // counts against, which folds 'incomplete' (died in flight) in with
      // 'failed'. Split them three ways if that lumping is wrong.
      successful_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} = 'complete')`.mapWith(Number),
      error_logs: sql<number>`COUNT(*) FILTER (WHERE ${logs.status} != 'complete')`.mapWith(Number),

      total_tokens:
        sql<number>`COALESCE(SUM(${logs.input_tokens}), 0) + COALESCE(SUM(${logs.output_tokens}), 0)`.mapWith(Number),
      total_input_tokens: sql<number>`COALESCE(SUM(${logs.input_tokens}), 0)`.mapWith(Number),
      total_output_tokens: sql<number>`COALESCE(SUM(${logs.output_tokens}), 0)`.mapWith(Number),

      average_input_tokens: sql<number>`ROUND(AVG(${logs.input_tokens}))`.mapWith(Number),
      average_output_tokens: sql<number>`ROUND(AVG(${logs.output_tokens}))`.mapWith(Number),

      average_output_tokens_per_second:
        sql<number>`ROUND(AVG(${logs.output_tokens}::numeric / NULLIF(${logs.response_time_ms}, 0) * 1000), 2)`.mapWith(
          Number,
        ),

      cost_total: sql<number>`COALESCE(SUM(${logs.input_cost}), 0) + COALESCE(SUM(${logs.output_cost}), 0)`.mapWith(
        Number,
      ),
      cost_input: sql<number>`COALESCE(SUM(${logs.input_cost}), 0)`.mapWith(Number),
      cost_output: sql<number>`COALESCE(SUM(${logs.output_cost}), 0)`.mapWith(Number),

      average_latency_ms: sql<number>`ROUND(AVG(${logs.response_time_ms}))`.mapWith(Number),
      maximum_latency_ms: max(logs.response_time_ms).mapWith(Number),
      minimum_latency_ms: min(logs.response_time_ms).mapWith(Number),

      p50_latency_ms: sql<number>`PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(
        Number,
      ),
      p95_latency_ms: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(
        Number,
      ),
      p99_latency_ms: sql<number>`PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${logs.response_time_ms})`.mapWith(
        Number,
      ),
    })
    .from(logs);

  const data = await query.where(and(...conditions));

  const parsed = Schemas.analytics.response.parse(data[0]);

  await redis.set(cacheKey, JSON.stringify(parsed), {
    expiration: { type: 'EX', value: 60 * 5 },
  });

  return parsed;
}

/**
 * The exclusive end of what the rollup covers, for this organization.
 *
 * The refresh worker never writes the hour in progress, so this is `max(bucket)
 * + 1 hour` rather than "now". An organization with no rollup rows at all falls
 * back to the current hour, which makes an empty range rather than a range
 * running back to the epoch.
 */
async function sealedThrough(organizationId: string): Promise<Date> {
  const [row] = await db.execute<{ sealed_through: Date }>(sql`
    select coalesce(
      (select max(${analyticsHourly.bucket}) + interval '1 hour'
         from ${analyticsHourly}
        where ${analyticsHourly.organization_id} = ${organizationId}),
      date_trunc('hour', now())
    ) as sealed_through
  `);

  if (!row) {
    throw new Error('Failed to read the analytics watermark');
  }

  return row.sealed_through;
}

/**
 * A time series and/or breakdown over the hourly rollup.
 *
 * This reads `analytics_hourly`, never `logs`. The same 30-day window costs
 * about 11 ms here against 1435 ms aggregated from raw rows, which is the whole
 * reason the rollup exists.
 *
 * Deliberately not Redis-cached, unlike queryAnalytics above. That cache exists
 * because the query behind it is expensive; this one is not, and a cache would
 * only add a second staleness window on top of the refresh interval the rollup
 * already has.
 *
 * @param request
 * The interval, the dimensions to pivot on, and any filters to narrow by.
 *
 * @returns
 * The points, plus the watermark they are current as of. Like queryAnalytics,
 * this has no expected refusal; an empty series is valid and dependency
 * failures reject rather than creating a Result whose error type is never.
 */
async function queryAnalyticsSeries(request: AnalyticsSeriesBody): Promise<AnalyticsSeriesResponse> {
  const organizationId = getCaller().organization.id;
  const watermark = await sealedThrough(organizationId);

  const grouped = new Set(request.group_by);

  // Every fragment below comes from a zod enum, so none of this interpolates
  // caller-controlled text into SQL - the values are already constrained to the
  // names of columns these tables have.
  const bucket =
    request.interval === 'none' ? sql`null::timestamptz` : sql`date_trunc(${request.interval}, unified.bucket)`;

  const dimension = (name: 'model' | 'provider' | 'status') =>
    grouped.has(name) ? sql.raw(`unified.${name}`) : sql`null::text`;

  const selected = [
    sql`${bucket} as bucket`,
    sql`${dimension('model')} as model`,
    sql`${dimension('provider')} as provider`,
    sql`${dimension('status')} as status`,
    grouped.has('actor') ? sql`unified.actor_type` : sql`null::text as actor_type`,
    grouped.has('actor') ? sql`unified.actor_id` : sql`null::uuid as actor_id`,
  ];

  // GROUP BY ordinal, not by repeating the expressions.
  //
  // Repeating them does not work here: `date_trunc($1, bucket)` in the select
  // and `date_trunc($4, bucket)` in the group by are different placeholders
  // even when both carry 'day', and Postgres compares the parse trees rather
  // than the values - so it rejects the bucket column as ungrouped. Ordinals
  // sidestep that, and the positions are fixed because the select list above
  // always emits the same six dimension columns in the same order.
  //
  // A dimension that was not grouped on is a null constant in that position and
  // must be left out, which is why each is conditional.
  const groupings: SQL[] = [];
  if (request.interval !== 'none') groupings.push(sql`1`);
  if (grouped.has('model')) groupings.push(sql`2`);
  if (grouped.has('provider')) groupings.push(sql`3`);
  if (grouped.has('status')) groupings.push(sql`4`);
  if (grouped.has('actor')) groupings.push(sql`5`, sql`6`);

  const startDate = request.start_date ? new Date(request.start_date) : undefined;
  const endDate = request.end_date ? new Date(request.end_date) : undefined;

  // The sealed side. `bucket < watermark` is not redundant with the watermark
  // read above: the worker could commit a newly sealed hour between that read
  // and this query, and without the bound that hour would be counted once from
  // the rollup and again from the tail. With it, the two sides partition the
  // timeline exactly, whatever the worker does concurrently.
  const sealedConditions = [
    sql`${analyticsHourly.organization_id} = ${organizationId}`,
    sql`${analyticsHourly.bucket} < ${watermark}`,
    startDate ? sql`${analyticsHourly.bucket} >= ${startDate}` : undefined,
    endDate ? sql`${analyticsHourly.bucket} < ${endDate}` : undefined,
    request.model ? sql`${analyticsHourly.model} = ${request.model}` : undefined,
    request.provider ? sql`${analyticsHourly.provider} = ${request.provider}` : undefined,
    request.status ? sql`${analyticsHourly.status} = ${request.status}` : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);

  // The live side, read from raw rows and aggregated into the sealed side's
  // shape. Bounded below by the watermark, so in the steady state this is the
  // current hour only - and if the refresh worker falls behind, this widens to
  // cover the gap rather than the dashboard silently losing those hours.
  const liveConditions = [
    sql`${logs.organization_id} = ${organizationId}`,
    sql`${logs.created_at} >= ${watermark}`,
    startDate ? sql`${logs.created_at} >= ${startDate}` : undefined,
    endDate ? sql`${logs.created_at} < ${endDate}` : undefined,
    request.model ? sql`${logs.model} = ${request.model}` : undefined,
    request.provider ? sql`${logs.provider} = ${request.provider}` : undefined,
    request.status ? sql`${logs.status} = ${request.status}` : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);

  // A ranking is ordered by size; a trend is ordered by time. Sorting a trend
  // by volume would draw the line in the wrong order entirely.
  const ordering = request.interval === 'none' ? sql`order by requests desc` : sql`order by bucket asc, requests desc`;

  // Only a ranking has a top. Applying it to a trend would silently truncate
  // the tail of the chart.
  const limit = request.interval === 'none' && request.limit ? sql`limit ${request.limit}` : sql``;

  const rows = await db.execute<Record<string, unknown>>(sql`
    with unified as (
      select
        ${analyticsHourly.bucket}        as bucket,
        ${analyticsHourly.model}         as model,
        ${analyticsHourly.provider}      as provider,
        ${analyticsHourly.status}        as status,
        ${analyticsHourly.actor_type}    as actor_type,
        ${analyticsHourly.actor_id}      as actor_id,
        ${analyticsHourly.requests}      as requests,
        ${analyticsHourly.input_tokens}  as input_tokens,
        ${analyticsHourly.output_tokens} as output_tokens,
        ${analyticsHourly.input_cost}    as input_cost,
        ${analyticsHourly.output_cost}   as output_cost,
        ${analyticsHourly.latency_sum}   as latency_sum,
        ${analyticsHourly.latency_count} as latency_count,
        ${analyticsHourly.latency_min}   as latency_min,
        ${analyticsHourly.latency_max}   as latency_max
      from ${analyticsHourly}
      where ${sql.join(sealedConditions, sql` and `)}

      union all

      -- Pre-aggregated to the hour here rather than unioned row by row, so the
      -- two sides meet at the same grain and the outer aggregate does the same
      -- arithmetic to both. Served by logs_org_created_idx.
      select
        date_trunc('hour', ${logs.created_at}),
        ${logs.model},
        ${logs.provider},
        ${logs.status},
        ${logs.actor_type},
        ${logs.actor_id},
        count(*),
        coalesce(sum(${logs.input_tokens}), 0),
        coalesce(sum(${logs.output_tokens}), 0),
        coalesce(sum(${logs.input_cost}), 0),
        coalesce(sum(${logs.output_cost}), 0),
        coalesce(sum(${logs.response_time_ms}), 0),
        -- count(column), not count(*): a row that never recorded a latency must
        -- not inflate the denominator of the average.
        count(${logs.response_time_ms}),
        min(${logs.response_time_ms}),
        max(${logs.response_time_ms})
      from ${logs}
      where ${sql.join(liveConditions, sql` and `)}
      group by 1, 2, 3, 4, 5, 6
    ),
    aggregated as (
      select
        ${sql.join(selected, sql`, `)},
        sum(unified.requests)::bigint      as requests,
        sum(unified.input_tokens)::bigint  as input_tokens,
        sum(unified.output_tokens)::bigint as output_tokens,
        sum(unified.input_cost)            as cost_input,
        sum(unified.output_cost)           as cost_output,
        -- Reconstructed from the accumulators rather than averaged. Averaging
        -- stored hourly averages is only correct when every hour carried the
        -- same request count, which is never true in practice.
        round(sum(unified.latency_sum)::numeric / nullif(sum(unified.latency_count), 0)) as average_latency_ms,
        min(unified.latency_min)                                                         as minimum_latency_ms,
        max(unified.latency_max)                                                         as maximum_latency_ms
      from unified
      ${groupings.length > 0 ? sql`group by ${sql.join(groupings, sql`, `)}` : sql``}
    )
    select
      aggregated.*,
      -- Resolved after aggregation, not before: actor_id is a grouping key, so
      -- joining per source row would be the same lookup repeated millions of
      -- times. Two joins because one column addresses two tables.
      coalesce(${apiKeys.name}, ${users.username}) as actor_label
    from aggregated
    left join ${apiKeys} on aggregated.actor_type = 'api_key' and ${apiKeys.id} = aggregated.actor_id
    left join ${users}   on aggregated.actor_type = 'user'    and ${users.id}   = aggregated.actor_id
    ${ordering}
    ${limit}
  `);

  const points = rows.map((row) => {
    const inputTokens = Number(row.input_tokens ?? 0);
    const outputTokens = Number(row.output_tokens ?? 0);
    const costInput = Number(row.cost_input ?? 0);
    const costOutput = Number(row.cost_output ?? 0);

    return {
      bucket: row.bucket instanceof Date ? row.bucket.toISOString() : null,

      model: (row.model as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      actor_type: (row.actor_type as string | null) ?? null,
      actor_id: (row.actor_id as string | null) ?? null,
      actor_label: (row.actor_label as string | null) ?? null,

      requests: Number(row.requests ?? 0),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,

      cost_input: costInput,
      cost_output: costOutput,
      cost_total: costInput + costOutput,

      average_latency_ms: row.average_latency_ms == null ? null : Number(row.average_latency_ms),
      minimum_latency_ms: row.minimum_latency_ms == null ? null : Number(row.minimum_latency_ms),
      maximum_latency_ms: row.maximum_latency_ms == null ? null : Number(row.maximum_latency_ms),
    };
  });

  return Schemas.series.response.parse({
    interval: request.interval,
    group_by: request.group_by,
    sealed_through: watermark.toISOString(),
    points,
  });
}

export default {
  queryAnalytics,
  queryAnalyticsSeries,
};
