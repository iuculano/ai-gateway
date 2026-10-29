import { clickhouse } from '@repo/clickhouse';
import { getCaller } from '@repo/hono';
import Schemas, { type AnalyticsSeriesBody, type AnalyticsSeriesResponse } from './analytics.schemas';

interface AggregateRow {
  bucket?: string;
  model?: string;
  provider?: string;
  status?: string;
  actor_type?: string;
  actor_id?: string;
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

// Just the metrics we want to select and aggregate
const METRICS = [
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

// Default ClickHouse setting seems to come back wihtout a timezone...
const settings = { date_time_output_format: 'iso' } as const;

async function queryAnalyticsSeries(request: AnalyticsSeriesBody): Promise<AnalyticsSeriesResponse> {
  // No bucket if the interval is 'none', just match all filters provided
  const hasBucket = request.interval !== 'none';
  const dimensions: string[] = [];
  if (hasBucket) {
    dimensions.push('bucket');
  }

  // Each dimension splits the totals further: ['bucket', 'provider'] gives one
  // row per hour (or day) per provider. 'actor' takes two columns.
  for (const name of new Set(request.group_by)) {
    if (name === 'actor') {
      dimensions.push('actor_type', 'actor_id');
    } else {
      dimensions.push(name);
    }
  }

  // Filters. Values go in as typed parameters, never as SQL text.
  const conditions = ['organization_id = {organization:UUID}'];
  if (request.start_date) conditions.push('created_at >= {start:DateTime64(3)}');
  if (request.end_date) conditions.push('created_at < {end:DateTime64(3)}');
  if (request.model) conditions.push('model = {model:String}');
  if (request.provider) conditions.push('provider = {provider:String}');
  if (request.status) conditions.push('status = {status:String}');

  // For example, { interval: 'hour', group_by: ['provider'] } comes out as:
  //
  //   WITH     toStartOfHour(created_at) AS bucket
  //   SELECT   bucket, provider, count() AS requests, ...
  //   FROM     logs FINAL WHERE organization_id = {organization:UUID}
  //   GROUP BY bucket, provider
  //   ORDER BY bucket, requests DESC
  //
  // Dimensions are both selected (to label each row) and grouped.
  const query = `
    WITH ${request.interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'}(created_at) AS bucket
    SELECT ${[...dimensions, ...METRICS].join(', ')}
    FROM logs FINAL
    WHERE ${conditions.join(' AND ')}
    ${dimensions.length > 0 ? `GROUP BY ${dimensions.join(', ')}` : ''}
    ORDER BY ${hasBucket ? 'bucket, ' : ''}requests DESC
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
    },
    clickhouse_settings: settings,
    format: 'JSONEachRow',
  });

  const rows = await result.json<AggregateRow>();

  return Schemas.series.response.parse({
    interval: request.interval,
    group_by: request.group_by,
    points: rows.map((row) => ({
      // Null unless grouped on.
      model: null,
      provider: null,
      status: null,
      actor_type: null,
      actor_id: null,
      ...row,
      bucket: row.bucket ? new Date(row.bucket) : null,
    })),
  });
}

export default {
  queryAnalyticsSeries,
};
