import type { InferRequestType } from 'hono/client';
import { client } from './client';

type ListAuditLogsRequest = InferRequestType<(typeof client)['audit-logs']['$get']>;

export type ListAuditLogsQuery = NonNullable<ListAuditLogsRequest['query']>;
export type AuditStatus = NonNullable<ListAuditLogsQuery['status']>;

export async function listAuditLogs(query: ListAuditLogsQuery = {}) {
  const response = await client['audit-logs'].$get({ query });
  return response.json();
}
