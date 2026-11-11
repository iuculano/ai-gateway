import { clickhouse } from '@repo/clickhouse';
import { getActorType } from '@repo/core';
import { getCaller } from '@repo/hono';
import Schemas, {
  type AnalyticsDimension,
  type AnalyticsSeriesBody,
  type AnalyticsSeriesResponse,
  type AnalyticsSessionDistributionBody,
  type AnalyticsSessionDistributionResponse,
  type AnalyticsSessionPositionsBody,
  type AnalyticsSessionPositionsResponse,
  type AnalyticsSessionsBody,
  type AnalyticsSessionsResponse,
  type AnalyticsTokensBody,
  type AnalyticsTokensResponse,
  type AnalyticsUsersBody,
  type AnalyticsUsersResponse,
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
  gateway_cache_hits: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_total: number;
  average_latency_ms: number | null;
  minimum_latency_ms: number | null;
  maximum_latency_ms: number | null;
  latency_quantiles: (number | null)[];
}

const METRIC_COLUMNS = [
  'count() AS requests',
  'countIf(gateway_cache_hit) AS gateway_cache_hits',
  'sumIf(logs.input_tokens, NOT gateway_cache_hit) AS input_tokens',
  'sumIf(logs.output_tokens, NOT gateway_cache_hit) AS output_tokens',
  'sumIf(logs.input_tokens + logs.output_tokens, NOT gateway_cache_hit) AS total_tokens',
  'toFloat64(sum(input_cost)) AS cost_input',
  'toFloat64(sum(output_cost)) AS cost_output',
  'toFloat64(sum(input_cost + output_cost)) AS cost_total',
  'round(avg(response_time_ms)) AS average_latency_ms', // nulls stay out of the average
  'min(response_time_ms) AS minimum_latency_ms',
  'max(response_time_ms) AS maximum_latency_ms',
  'quantiles(0.5, 0.95)(response_time_ms) AS latency_quantiles',
];

// What a result row can be grouped by, in a fixed order.
const GROUP_BY_KEYS = ['bucket', 'model', 'provider', 'status', 'actor', 'user', 'session'];

const settings = {
  date_time_output_format: 'iso', // ClickHouse's default format leaves the timezone off.
  group_by_use_nulls: 1, // Keys a row isn't grouped by come back null rather than '' or 0.
  use_query_cache: 1,
} as const;

/**
 * Works out the set_mask that marks a grouping's rows in a GROUPING SETS result.
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
 * Turns ClickHouse's NaN or null, which it returns when there was nothing to
 * measure, into null.
 *
 * @param value
 * The value ClickHouse returned.
 *
 * @returns
 * The value if it's a finite number, or null otherwise.
 */
function measured(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

/**
 * Builds the WHERE clause, parameters and cache settings that every analytics
 * query shares, scoped to the caller's organization.
 *
 * @param request
 * The filters. Any that are unset don't narrow anything.
 */
function queryOptionsFor(
  request: Pick<AnalyticsSeriesBody, 'start_date' | 'end_date'> &
    Partial<Pick<AnalyticsSeriesBody, 'model' | 'provider' | 'status' | 'actor_id' | 'user_id' | 'session_id'>>,
) {
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

  return {
    where: conditions.join(' AND '),
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
  };
}

/**
 * Totals and breakdowns of usage, spend and latency, answering several
 * groupings in one scan.
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

  const { where, ...options } = queryOptionsFor(request);

  const query = `
    SELECT ${[...selectedKeys, `${setMask} AS set_mask`, ...METRIC_COLUMNS].join(', ')}
    FROM logs FINAL
    WHERE ${where}
    GROUP BY GROUPING SETS (${[...sets].join(', ')})
    ORDER BY bucket, requests DESC, ${GROUP_BY_KEYS.join(', ')}
  `;

  const result = await clickhouse.query({ query, ...options, format: 'JSONEachRow' });

  // Rows for every grouping arrive mixed together.
  const rows = await result.json<AggregateRow>();
  const rowsByMask = Map.groupBy(rows, (row) => row.set_mask);

  // Answer each grouping in the order it was asked, from its pile.
  const groupings: { group_by: AnalyticsDimension[]; points: unknown[] }[] = [];

  for (const { grouping, keys } of requested) {
    const mask = maskOf(keys, usedKeys);
    const groupingRows = rowsByMask.get(mask) ?? [];

    // ClickHouse hands bucket back as an ISO string, and the response wants a
    // Date. The actor's type comes out of its id.
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
        median_latency_ms: measured(row.latency_quantiles[0]),
        p95_latency_ms: measured(row.latency_quantiles[1]),
      });
    }

    groupings.push({ group_by: grouping, points });
  }

  return Schemas.series.response.parse({ interval: request.interval, groupings });
}

// p1 to p99, for placing one user's or session's spend among everyone's.
const PERCENTILES = Array.from({ length: 99 }, (_, index) => (index + 1) / 100).join(', ');

/**
 * A page of users from the user_id tag, with how many there are and how their
 * spend spreads.
 *
 * @param request
 * The date range, an optional API key to narrow to, the order, and the page.
 */
async function queryAnalyticsUsers(request: AnalyticsUsersBody): Promise<AnalyticsUsersResponse> {
  const { where, ...options } = queryOptionsFor(request);

  // Biggest first by the chosen measure. Ties are broken by id, so pages don't
  // overlap or skip. The OVER () columns see every user, before the LIMIT.
  const sortColumn = { spend: 'cost_total', tokens: 'tokens', requests: 'requests' }[request.sort];
  const query = `
    SELECT
      user_id,
      count() AS requests,
      sumIf(logs.input_tokens + logs.output_tokens, NOT gateway_cache_hit) AS tokens,
      toFloat64(sum(input_cost + output_cost)) AS cost_total,
      count() OVER () AS active_users,
      quantiles(${PERCENTILES})(toFloat64(sum(input_cost + output_cost))) OVER () AS cost_percentiles
    FROM logs FINAL WHERE ${where} AND logs.user_id != ''
    GROUP BY user_id
    ORDER BY ${sortColumn} DESC, user_id
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await clickhouse.query({
    query,
    ...options,
    query_params: { ...options.query_params, limit: request.limit, offset: request.offset },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    user_id: string;
    requests: number;
    tokens: number;
    cost_total: number;
    active_users: number;
    cost_percentiles: number[];
  }>();

  return Schemas.users.response.parse({
    active_users: rows[0]?.active_users ?? 0,
    cost_percentiles: rows[0]?.cost_percentiles ?? [],
    users: rows,
  });
}

/**
 * A page of sessions from the session_id tag, with how many there are.
 *
 * @param request
 * The date range, an optional API key, user or session to narrow to, the
 * order, and the page.
 */
async function queryAnalyticsSessions(request: AnalyticsSessionsBody): Promise<AnalyticsSessionsResponse> {
  const { where, ...options } = queryOptionsFor(request);

  // Biggest first by the chosen measure, with ties broken by id so pages don't
  // overlap or skip.
  const sortColumn = { spend: 'cost_total', requests: 'requests', length: 'seconds' }[request.sort];
  const query = `
    SELECT
      session_id,
      uniqExactIf(logs.user_id, logs.user_id != '') AS users,
      if(users = 1, anyIf(logs.user_id, logs.user_id != ''), '') AS user_id,
      count() AS requests,
      sumIf(input_tokens + output_tokens, NOT gateway_cache_hit) AS tokens,
      toFloat64(sum(input_cost + output_cost)) AS cost_total,
      dateDiff('second', min(logs.created_at), max(logs.created_at)) AS seconds,
      count() OVER () AS sessions
    FROM logs FINAL WHERE ${where} AND session_id != ''
    GROUP BY session_id
    ORDER BY ${sortColumn} DESC, session_id
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const result = await clickhouse.query({
    query,
    ...options,
    query_params: { ...options.query_params, limit: request.limit, offset: request.offset },
    format: 'JSONEachRow',
  });
  const top = await result.json<{
    session_id: string;
    user_id: string;
    users: number;
    requests: number;
    tokens: number;
    cost_total: number;
    seconds: number;
    sessions: number;
  }>();

  return Schemas.sessions.response.parse({ count: top[0]?.sessions ?? 0, top });
}

// Where each session band starts, in dollars of spend and in requests.
const COST_BANDS = [0, 0.01, 0.1, 1, 10];
const REQUEST_BANDS = [1, 2, 6, 11, 21];

/**
 * How spend, request count and length spread across sessions, as percentiles
 * and bands.
 *
 * @param request
 * The date range, and an optional API key or user to narrow to.
 */
async function queryAnalyticsSessionDistribution(
  request: AnalyticsSessionDistributionBody,
): Promise<AnalyticsSessionDistributionResponse> {
  const { where, ...options } = queryOptionsFor(request);
  const costBands = bandConditions('cost_total', COST_BANDS);
  const requestBands = bandConditions('requests', REQUEST_BANDS);

  // A query of its own, so the spread is worked out once rather than repeated
  // on every listed session.
  const query = `
    SELECT
      count() AS sessions,
      quantiles(${PERCENTILES})(cost_total) AS cost_percentiles,
      quantiles(${PERCENTILES})(requests) AS request_percentiles,
      quantiles(${PERCENTILES})(seconds) AS seconds_percentiles,
      [${costBands.map((band) => `countIf(${band})`).join(', ')}] AS cost_band_sessions,
      [${costBands.map((band) => `sumIf(cost_total, ${band})`).join(', ')}] AS cost_band_spend,
      [${requestBands.map((band) => `countIf(${band})`).join(', ')}] AS request_band_sessions
    FROM (
      SELECT
        count() AS requests,
        toFloat64(sum(input_cost + output_cost)) AS cost_total,
        dateDiff('second', min(logs.created_at), max(logs.created_at)) AS seconds
      FROM logs FINAL WHERE ${where} AND session_id != ''
      GROUP BY session_id
    )
  `;

  const result = await clickhouse.query({ query, ...options, format: 'JSONEachRow' });

  // Exactly one row, even over no sessions at all.
  const [row] = await result.json<{
    sessions: number;
    cost_percentiles: number[];
    request_percentiles: number[];
    seconds_percentiles: number[];
    cost_band_sessions: number[];
    cost_band_spend: number[];
    request_band_sessions: number[];
  }>();
  const sessions = row?.sessions ?? 0;

  const costRows = [];
  for (const [index, min] of COST_BANDS.entries()) {
    costRows.push({
      min,
      max: COST_BANDS[index + 1] ?? null,
      sessions: row?.cost_band_sessions[index] ?? 0,
      cost_total: row?.cost_band_spend[index] ?? 0,
    });
  }
  const requestRows = [];
  for (const [index, min] of REQUEST_BANDS.entries()) {
    // Request counts are whole, so a band ends just before the next starts.
    const next = REQUEST_BANDS[index + 1];
    requestRows.push({
      min,
      max: next === undefined ? null : next - 1,
      sessions: row?.request_band_sessions[index] ?? 0,
    });
  }

  return Schemas.sessionDistribution.response.parse({
    sessions,
    // Over no sessions the quantiles come back as NaN, so there is nothing to place.
    cost_percentiles: sessions > 0 ? row?.cost_percentiles : [],
    request_percentiles: sessions > 0 ? row?.request_percentiles : [],
    seconds_percentiles: sessions > 0 ? row?.seconds_percentiles : [],
    cost_bands: costRows,
    request_bands: requestRows,
  });
}

// Requests past this position in a session are counted together in it.
const MAX_POSITION = 1000;

/**
 * What a session's requests cost and send, by their position in it, across
 * every session or within one.
 *
 * @param request
 * The date range, and an optional API key, user or session to narrow to.
 */
async function queryAnalyticsSessionPositions(
  request: AnalyticsSessionPositionsBody,
): Promise<AnalyticsSessionPositionsResponse> {
  const { where, ...options } = queryOptionsFor(request);

  // Numbering each session's sorted requests costs about a third of the CPU of
  // row_number() over the same rows.
  const query = `
    SELECT
      least(step, ${MAX_POSITION}) AS position,
      count() AS requests,
      countIf(step <= ${MAX_POSITION}) AS sessions,
      toFloat64(sum(cost)) AS cost_total,
      sum(input) AS input_tokens
    FROM (
      SELECT arraySort(groupArray((logs.created_at, logs.id, toFloat64(input_cost + output_cost), logs.input_tokens))) AS steps
      FROM logs FINAL WHERE ${where} AND session_id != ''
      GROUP BY session_id
    )
    ARRAY JOIN arrayEnumerate(steps) AS step, steps.3 AS cost, steps.4 AS input
    GROUP BY position
    ORDER BY position
  `;

  const result = await clickhouse.query({ query, ...options, format: 'JSONEachRow' });
  const positions = await result.json<{
    position: number;
    requests: number;
    sessions: number;
    cost_total: number;
    input_tokens: number;
  }>();

  return Schemas.sessionPositions.response.parse({ positions });
}

// Where each token band starts, per request.
const INPUT_BANDS = [0, 1_000, 4_000, 16_000, 64_000];
const OUTPUT_BANDS = [0, 100, 500, 2_000, 8_000];

/**
 * Writes each band's range as a SQL condition on a column. The last band has no
 * upper end.
 *
 * @param column
 * The column or alias to compare.
 *
 * @param starts
 * Where each band starts, in order.
 */
function bandConditions(column: string, starts: number[]) {
  const conditions = [];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1];
    conditions.push(end === undefined ? `${column} >= ${start}` : `${column} >= ${start} AND ${column} < ${end}`);
  }
  return conditions;
}

/**
 * Pairs each token band's range with how many requests fell in it.
 *
 * @param starts
 * Where each band starts, in order.
 *
 * @param counts
 * The requests in each band, in the same order.
 */
function bandsOf(starts: number[], counts: number[]) {
  const bands = [];
  for (const [index, min] of starts.entries()) {
    bands.push({ min, max: starts[index + 1] ?? null, requests: counts[index] ?? 0 });
  }
  return bands;
}

/**
 * Token totals, prompt cache use, and how big requests and answers typically
 * are.
 *
 * @param request
 * The date range, and an optional API key or user to narrow to.
 */
async function queryAnalyticsTokens(request: AnalyticsTokensBody): Promise<AnalyticsTokensResponse> {
  const { where, ...options } = queryOptionsFor(request);
  const inputBands = bandConditions('logs.input_tokens', INPUT_BANDS);
  const outputBands = bandConditions('logs.output_tokens', OUTPUT_BANDS);

  const query = `
    SELECT
      countIf(logs.status = 'complete') AS requests,
      sum(logs.input_tokens) AS input_tokens,
      sum(logs.output_tokens) AS output_tokens,
      sum(logs.cached_input_tokens) AS cached_input_tokens,
      quantilesIf(0.5, 0.95)(logs.input_tokens, logs.status = 'complete') AS input_quantiles,
      quantilesIf(0.5, 0.95)(logs.output_tokens, logs.status = 'complete') AS output_quantiles,
      [${inputBands.map((band) => `countIf(${band} AND logs.status = 'complete')`).join(', ')}] AS input_bands,
      [${outputBands.map((band) => `countIf(${band} AND logs.status = 'complete')`).join(', ')}] AS output_bands
    FROM logs FINAL WHERE ${where} AND NOT gateway_cache_hit
  `;

  const result = await clickhouse.query({ query, ...options, format: 'JSONEachRow' });

  // Exactly one row, even over no logs at all.
  const [row] = await result.json<{
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    input_quantiles: (number | null)[];
    output_quantiles: (number | null)[];
    input_bands: number[];
    output_bands: number[];
  }>();

  return Schemas.tokens.response.parse({
    requests: row?.requests ?? 0,
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cached_input_tokens: row?.cached_input_tokens ?? 0,
    median_input_tokens: measured(row?.input_quantiles[0]),
    p95_input_tokens: measured(row?.input_quantiles[1]),
    median_output_tokens: measured(row?.output_quantiles[0]),
    p95_output_tokens: measured(row?.output_quantiles[1]),
    input_bands: bandsOf(INPUT_BANDS, row?.input_bands ?? []),
    output_bands: bandsOf(OUTPUT_BANDS, row?.output_bands ?? []),
  });
}

export default {
  queryAnalyticsSeries,
  queryAnalyticsUsers,
  queryAnalyticsSessions,
  queryAnalyticsSessionDistribution,
  queryAnalyticsSessionPositions,
  queryAnalyticsTokens,
};
