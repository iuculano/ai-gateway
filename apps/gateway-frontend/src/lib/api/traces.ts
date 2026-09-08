import type { InferRequestType } from 'hono/client';
import { client } from './client';

type ListTracesRequest = InferRequestType<(typeof client)['traces']['$get']>;

export type ListTracesQuery = NonNullable<ListTracesRequest['query']>;
export type TraceStatus = NonNullable<ListTracesQuery['status']>;

export async function listTraces(query: ListTracesQuery = {}) {
  const response = await client.traces.$get({ query });
  return response.json();
}

/**
 * One trace's summary and its whole waterfall.
 *
 * Keyed by W3C trace id, not by the row's uuid - that is the handle the gateway
 * hands back on every inference as `ai-trace-id`.
 *
 * The nodes arrive in render order with their depth already resolved, so a
 * caller draws the list top to bottom without rebuilding the tree. Application
 * spans and gateway logs are the same shape here on purpose.
 */
export async function getTrace(traceId: string) {
  const response = await client.traces[':trace_id'].$get({ param: { trace_id: traceId } });
  return response.json();
}
