import type { createApiKey, getApiKeyStats, listApiKeys } from './api-keys';
import type { listAuditLogs } from './audit-logs';
import type { getLogRequest, getLogRequestBatch, listLogs } from './logs';

// These aliases come from the Hono RPC return types, so backend schema changes
// now reach frontend consumers without a second handwritten response model.
type ApiKeyList = Awaited<ReturnType<typeof listApiKeys>>;
type AuditLogList = Awaited<ReturnType<typeof listAuditLogs>>;
type LogList = Awaited<ReturnType<typeof listLogs>>;

export type ApiKey = ApiKeyList['data'][number];
export type CreatedApiKey = Awaited<ReturnType<typeof createApiKey>>;
export type ApiKeyStats = Awaited<ReturnType<typeof getApiKeyStats>>;
export type ListMeta = ApiKeyList['meta'];

export type AuditLog = AuditLogList['data'][number];
export type AuditActorType = AuditLog['actor_type'];
export type AuditStatus = AuditLog['status'];

export type Log = LogList['data'][number];
export type LogStatus = Log['status'];
export type LogListMeta = LogList['meta'];
export type LogPayload = Awaited<ReturnType<typeof getLogRequest>>;
export type LogBatch = Awaited<ReturnType<typeof getLogRequestBatch>>;
