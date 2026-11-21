import type { InferRequestType } from 'hono/client';
import { client } from './client';

type ListLogsRequest = InferRequestType<(typeof client)['logs']['$get']>;

export type ListLogsQuery = NonNullable<ListLogsRequest['query']>;
export type LogStatus = NonNullable<ListLogsQuery['status']>;

export async function listLogs(query: ListLogsQuery = {}) {
  const response = await client.logs.$get({ query });
  return response.json();
}

/**
 * The payload as it was submitted / returned.
 *
 * Two separate objects in storage, so a view that only needs one side never
 * pays for the other. Both 404 when nothing was stored - check has_request /
 * has_response on the row before calling.
 */
export async function getLogRequest(id: string) {
  const response = await client.logs[':id'].request.$get({ param: { id } });
  return response.json();
}

export async function getLogResponse(id: string) {
  const response = await client.logs[':id'].response.$get({ param: { id } });
  return response.json();
}

export async function countLogs() {
  const response = await client.logs.count.$get();
  return response.json();
}
