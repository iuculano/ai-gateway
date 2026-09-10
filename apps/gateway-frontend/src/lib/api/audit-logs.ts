import type { InferRequestType } from 'hono/client';
import { resolveActorNames } from './actors';
import { client } from './client';

type ListAuditLogsRequest = InferRequestType<(typeof client)['audit-logs']['$get']>;

export type ListAuditLogsQuery = NonNullable<ListAuditLogsRequest['query']>;
export type AuditStatus = NonNullable<ListAuditLogsQuery['status']>;

export async function listAuditLogs(query: ListAuditLogsQuery = {}) {
  const response = await client['audit-logs'].$get({ query });
  const result = await response.json();
  const actorName = await resolveActorNames(result.data);
  return { ...result, data: result.data.map((log) => ({ ...log, actor_name: actorName(log) })) };
}
