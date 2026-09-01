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

/**
 * Many payloads at once, fetched concurrently server-side.
 *
 * POST rather than GET because the id list is the payload. Capped at 100 by the
 * backend. Ids that resolve to nothing come back in meta.missing rather than
 * failing the call, so a partially expired page still renders.
 */
export async function getLogRequestBatch(ids: string[]) {
  const response = await client.logs.batch.request.$post({ json: { ids } });
  return response.json();
}

export async function getLogResponseBatch(ids: string[]) {
  const response = await client.logs.batch.response.$post({ json: { ids } });
  return response.json();
}

export async function deleteLog(id: string): Promise<void> {
  await client.logs[':id'].$delete({ param: { id } });
}
