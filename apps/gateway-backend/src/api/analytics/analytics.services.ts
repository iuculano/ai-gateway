import { clickhouse } from '@repo/clickhouse';
import { getActorType } from '@repo/core';
import { getCaller } from '@repo/hono';
import Schemas, {
  type AnalyticsDimension,
  type AnalyticsSeriesBody,
  type AnalyticsSeriesResponse,
} from './analytics.schemas';

// A result row as ClickHouse hands it back.
interface AggregateRow {
  set_mask: number;
  bucket: string | null;
  model: string | null;
  provider: string | null;
  status: string | null;
  actor: string | null;
  user: string | null;
  session: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_total: number;
  average_latency_ms: number | null;
  minimum_latency_ms: number | null;
  maximum_latency_ms: number | null;
}

const METRIC_COLUMNS = [
  'count() AS requests',
  'sum(input_tokens) AS input_tokens',
  'sum(output_tokens) AS output_tokens',
  'sum(logs.input_tokens + logs.output_tokens) AS total_tokens', // watch the naming...
  'toFloat64(sum(input_cost)) AS cost_input',
  'toFloat64(sum(output_cost)) AS cost_output',
  'toFloat64(sum(input_cost + output_cost)) AS cost_total',
  'round(avg(response_time_ms)) AS average_latency_ms', // nulls stay out of the average
  'min(response_time_ms) AS minimum_latency_ms',
  'max(response_time_ms) AS maximum_latency_ms',
];

// What a result row can be grouped by, in a fixed order.
const GROUP_BY_KEYS = ['bucket', 'model', 'provider', 'status', 'actor', 'user', 'session'];

const settings = {
  date_time_output_format: 'iso', // Default ClickHouse setting seems to come back wihtout a timezone...
  group_by_use_nulls: 1, // Keys a row isn't grouped by come back null rather than '' or 0.
  use_query_cache: 1,
} as const;

/**
 * Works out which rows of the combined result belong to a grouping.
 *
 * @param groupingKeys
 * The group-by keys of this grouping.
 *
 * @param usedKeys
 * Every key any grouping in the query uses, in the order they were passed to
 * grouping(). The order sets which bit is which, so it must match the query.
 *
 * @returns
 * The set_mask the grouping's rows carry.
 */
function maskOf(groupingKeys: string[], usedKeys: string[]): number {
  let mask = 0;

  // One bit per used key, in order
  for (const key of usedKeys) {
    mask = (mask << 1) | (groupingKeys.includes(key) ? 0 : 1);
  }

  return mask;
}

/**
 * What it says on the tin.
 *
 * @param request
 * The date range, filters, bucket size, and the groupings to answer.
 */
async function queryAnalyticsSeries(request: AnalyticsSeriesBody): Promise<AnalyticsSeriesResponse> {
  const requested: { grouping: AnalyticsDimension[]; keys: string[] }[] = [];

  for (const grouping of request.groupings) {
    const dimensions = new Set<string>(grouping);
    requested.push({ grouping, keys: GROUP_BY_KEYS.filter((key) => dimensions.has(key)) });
  }

  // The set means a grouping asked for twice only gets answered once.
  const sets = new Set(requested.map(({ keys }) => `(${keys.join(', ')})`));

  const usedKeys = GROUP_BY_KEYS.filter((key) => requested.some(({ keys }) => keys.includes(key)));
  const expressions: Record<string, string> = {
    bucket: `${request.interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'}(created_at)`,
    actor: 'actor_id',
    user: 'user_id',
    session: 'session_id',
  };
  const selectedKeys = GROUP_BY_KEYS.map((key) => {
    if (!usedKeys.includes(key)) return `NULL AS ${key}`;
    return expressions[key] ? `${expressions[key]} AS ${key}` : key;
  });

  // Tags every row with the grouping it belongs to (see maskOf).
  const setMask = usedKeys.length > 0 ? `grouping(${usedKeys.join(', ')})` : '0';

  const conditions = ['logs.organization_id = {organization:UUID}'];
  if (request.start_date) conditions.push('logs.created_at >= {start:DateTime64(3)}');
  if (request.end_date) conditions.push('logs.created_at < {end:DateTime64(3)}');
  if (request.model) conditions.push('logs.model = {model:String}');
  if (request.provider) conditions.push('logs.provider = {provider:String}');
  if (request.status) conditions.push('logs.status = {status:String}');
  if (request.actor_id) conditions.push('logs.actor_id = {actor:UUID}');
  if (request.user_id !== undefined) conditions.push('logs.user_id = {user:String}');
  if (request.session_id !== undefined) conditions.push('logs.session_id = {session:String}');

  // Ranges that ended over an hour ago can't change anymore, so cache them for
  // the 5 minutes the page keeps asking for the same window.
  const settled = request.end_date !== undefined && request.end_date.getTime() < Date.now() - 3_600_000;

  const query = `
    SELECT ${[...selectedKeys, `${setMask} AS set_mask`, ...METRIC_COLUMNS].join(', ')}
    FROM logs FINAL
    WHERE ${conditions.join(' AND ')}
    GROUP BY GROUPING SETS (${[...sets].join(', ')})
    ORDER BY bucket, requests DESC, ${GROUP_BY_KEYS.join(', ')}
  `;

  const result = await clickhouse.query({
    query,
    query_params: {
      organization: getCaller().organization.id,
      start: request.start_date,
      end: request.end_date,
      model: request.model,
      provider: request.provider,
      status: request.status,
      actor: request.actor_id,
      user: request.user_id,
      session: request.session_id,
    },
    clickhouse_settings: { ...settings, query_cache_ttl: settled ? 300 : 10 },
    format: 'JSONEachRow',
  });

  // Rows for every grouping arrive mixed together.
  const rows = await result.json<AggregateRow>();
  const rowsByMask = Map.groupBy(rows, (row) => row.set_mask);

  // Answer each grouping in the order it was asked, from its pile.
  const groupings: { group_by: AnalyticsDimension[]; points: unknown[] }[] = [];

  for (const { grouping, keys } of requested) {
    const mask = maskOf(keys, usedKeys);
    const groupingRows = rowsByMask.get(mask) ?? [];

    // ClickHouse hands bucket back as an ISO string; the response wants a Date.
    // The actor's type comes out of its id.
    const points = [];
    for (const row of groupingRows) {
      const bucket = row.bucket ? new Date(row.bucket) : null;
      const actorType = row.actor ? getActorType(row.actor) : null;
      points.push({
        ...row,
        bucket,
        actor_id: row.actor,
        actor_type: actorType,
        user_id: row.user,
        session_id: row.session,
      });
    }

    groupings.push({ group_by: grouping, points });
  }

  return Schemas.series.response.parse({ interval: request.interval, groupings });
}

export default {
  queryAnalyticsSeries,
};
