import type { InferResponseType } from 'hono/client';
import { topCallerReferences } from '$lib/data/caller-ranking';
import { resolveActorNames } from './actors';
import { client } from './client';

export type AnalyticsInterval = 'hour' | 'day';
export type AnalyticsDimension = 'bucket' | 'model' | 'provider' | 'status' | 'actor';

export interface SeriesRequest {
  start_date?: string;
  end_date?: string;
  interval?: AnalyticsInterval;
  groupings: AnalyticsDimension[][];
  model?: string;
  provider?: string;
  status?: 'incomplete' | 'complete' | 'failed';
}

/**
 * Several groupings of the same logs from ClickHouse, in one request and one
 * scan: one array of points per grouping, in the order asked. `[]` is the
 * totals, and 'bucket' keeps the time axis (hour or day, per `interval`).
 */
export async function fetchSeries(request: SeriesRequest): Promise<SeriesPoint[][]> {
  const response = await client.analytics.series.$post({ json: request });
  const result = await response.json();
  const groupings: SeriesPoint[][] = [];

  for (const grouping of result.groupings) {
    if (!grouping.group_by.includes('actor')) {
      groupings.push(grouping.points);
      continue;
    }

    // Only the top six in either view need display names. Keep all aggregates
    // for accurate spend ranking and shares without resolving every caller.
    const actorName = await resolveActorNames(topCallerReferences(grouping.points));
    groupings.push(grouping.points.map((point) => ({ ...point, actor_label: actorName(point) })));
  }

  return groupings;
}

export type SeriesResponse = InferResponseType<typeof client.analytics.series.$post, 200>;
// actor_label is filled in by fetchSeries for actor breakdowns.
export type SeriesPoint = SeriesResponse['groupings'][number]['points'][number] & { actor_label?: string };
