import type { InferRequestType, InferResponseType } from 'hono/client';
import { topCallerReferences } from '$lib/data/caller-ranking';
import { resolveActorNames } from './actors';
import { client } from './client';

export type AnalyticsInterval = 'hour' | 'day';

export type SeriesRequest = InferRequestType<typeof client.analytics.series.$post>['json'];

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

export type UsersRequest = InferRequestType<typeof client.analytics.users.$post>['json'];

/** A page of users (the user_id tag), and how many there are. */
export async function fetchUsers(request: UsersRequest) {
  const response = await client.analytics.users.$post({ json: request });
  return response.json();
}

export type UsersResponse = InferResponseType<typeof client.analytics.users.$post, 200>;

export type SessionsRequest = InferRequestType<typeof client.analytics.sessions.$post>['json'];

/** How many sessions there were (the session_id tag) and the most expensive. */
export async function fetchSessions(request: SessionsRequest) {
  const response = await client.analytics.sessions.$post({ json: request });
  return response.json();
}

export type SessionsResponse = InferResponseType<typeof client.analytics.sessions.$post, 200>;

export type TokensRequest = InferRequestType<typeof client.analytics.tokens.$post>['json'];

/** Median and p95 tokens per request, in and out, over the requests a provider answered. */
export async function fetchTokens(request: TokensRequest) {
  const response = await client.analytics.tokens.$post({ json: request });
  return response.json();
}

export type TokensResponse = InferResponseType<typeof client.analytics.tokens.$post, 200>;
