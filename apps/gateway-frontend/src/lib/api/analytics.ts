import type { AnalyticsSeriesResponse } from 'gateway-backend/schemas/analytics';
import { client } from './client';

export type AnalyticsInterval = 'hour' | 'day' | 'none';
export type AnalyticsDimension = 'model' | 'provider' | 'status' | 'actor';

export interface SeriesRequest {
  start_date?: string;
  end_date?: string;
  interval?: AnalyticsInterval;
  group_by?: AnalyticsDimension[];
  model?: string;
  provider?: string;
  status?: 'incomplete' | 'complete' | 'failed';
  limit?: number;
}

/**
 * A time series and/or breakdown from the hourly rollup.
 *
 * One endpoint rather than one per chart: the dashboard's panels differ only in
 * which dimensions they pivot on and whether they keep the time axis, so a
 * `group_by` is a parameter rather than a new route. `interval: 'none'` collapses
 * time entirely, which is what the two ranked lists want.
 *
 * The response carries `sealed_through`. The refresh worker never aggregates the
 * hour in progress, so that is the point the numbers are current as of - the UI
 * says so rather than drawing a final bucket that only looks like traffic
 * falling off a cliff.
 */
export async function fetchSeries(request: SeriesRequest) {
  const response = await client.analytics.series.$post({ json: request });
  return response.json();
}

// Taken from the backend's own schema rather than inferred off the client.
// The RPC client's response type collapses to `never` through the status-code
// pick, and a chart silently typed as `never` compiles right up until it is
// read. Same import style as chat-completions.
export type SeriesResponse = AnalyticsSeriesResponse;
export type SeriesPoint = AnalyticsSeriesResponse['points'][number];
