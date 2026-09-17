import { db, sql } from '@repo/drizzle';
import { analyticsHourly, apiKeys, logs, users } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
import type { SQL } from 'drizzle-orm';
import Schemas, { type AnalyticsSeriesBody, type AnalyticsSeriesResponse } from './analytics.schemas';

/**
 * Returns the start of the hour after the latest rollup.
 *
 * For example, if a 14:00 rollup covers 14:00–15:00, this returns 15:00. Logs
 *
 * from then onward are read directly. With no rollups, returns the start of the
 * current hour.
 *
 * @param organizationId
 * The ID of the organization for which to determine the start of live logs.
 */
async function getLiveLogsStart(organizationId: string): Promise<Date> {
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
 * Deliberately not Redis-cached, a cache would add a second staleness window on
 * top of the rollup refresh interval.
 *
 * @param request
 * The interval, the dimensions to pivot on, and any filters to narrow by.
 *
 * @returns
 * The points, plus the watermark they are current as of.
 */
async function queryAnalyticsSeries(request: AnalyticsSeriesBody): Promise<AnalyticsSeriesResponse> {
  const organizationId = getCaller().organization.id;
  const watermark = await getLiveLogsStart(organizationId);

  const grouped = new Set(request.group_by);

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

  // Group by column positions so repeated date_trunc parameters cannot
  // conflict. Only include dimensions selected for grouping.
  const groupings: SQL[] = [];
  if (request.interval !== 'none') groupings.push(sql`1`);
  if (grouped.has('model')) groupings.push(sql`2`);
  if (grouped.has('provider')) groupings.push(sql`3`);
  if (grouped.has('status')) groupings.push(sql`4`);
  if (grouped.has('actor')) groupings.push(sql`5`, sql`6`);

  const startDate = request.start_date;
  const endDate = request.end_date;

  // The shared watermark prevents double-counting if the rollup advances
  // mid-query.
  const sealedConditions = [
    sql`${analyticsHourly.organization_id} = ${organizationId}`,
    sql`${analyticsHourly.bucket} < ${watermark}`,
    startDate ? sql`${analyticsHourly.bucket} >= ${startDate}` : undefined,
    endDate ? sql`${analyticsHourly.bucket} < ${endDate}` : undefined,
    request.model ? sql`${analyticsHourly.model} = ${request.model}` : undefined,
    request.provider ? sql`${analyticsHourly.provider} = ${request.provider}` : undefined,
    request.status ? sql`${analyticsHourly.status} = ${request.status}` : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);

  // Include logs the rollup has not covered yet.
  const liveConditions = [
    sql`${logs.organization_id} = ${organizationId}`,
    sql`${logs.created_at} >= ${watermark}`,
    startDate ? sql`${logs.created_at} >= ${startDate}` : undefined,
    endDate ? sql`${logs.created_at} < ${endDate}` : undefined,
    request.model ? sql`${logs.model} = ${request.model}` : undefined,
    request.provider ? sql`${logs.provider} = ${request.provider}` : undefined,
    request.status ? sql`${logs.status} = ${request.status}` : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);

  // Sort breakdowns by volume and time series chronologically.
  const ordering = request.interval === 'none' ? sql`order by requests desc` : sql`order by bucket asc, requests desc`;

  // Limit breakdowns only; time series need every bucket.
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

      -- Aggregate live logs to the same hourly granularity as the rollup.
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
        -- Exclude missing latencies from the average.
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
        -- Calculate the weighted average from totals.
        round(sum(unified.latency_sum)::numeric / nullif(sum(unified.latency_count), 0)) as average_latency_ms,
        min(unified.latency_min)                                                         as minimum_latency_ms,
        max(unified.latency_max)                                                         as maximum_latency_ms
      from unified
      ${groupings.length > 0 ? sql`group by ${sql.join(groupings, sql`, `)}` : sql``}
    )
    select
      aggregated.*,
      -- Resolve actor names once per aggregate.
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
      bucket: row.bucket ?? null,

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
    sealed_through: watermark,
    points,
  });
}

export default {
  queryAnalyticsSeries,
};
