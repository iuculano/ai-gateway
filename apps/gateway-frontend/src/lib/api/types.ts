import type { createApiKey, getApiKeyStats, listApiKeys } from './api-keys';
import type { listAuditLogs } from './audit-logs';
import type { createChatCompletion } from './chat-completions';
import type { getLogRequest, getLogRequestBatch, listLogs } from './logs';
import type { listProviders } from './models';
import type { getPromptVersion, listPrompts, listPromptVersions, renderPromptVersion } from './prompts';
import type { getTrace, listTraces } from './traces';
import type { createWebhook, listWebhookDeliveries, listWebhookOutbox, listWebhooks } from './webhooks';

// These aliases come from the Hono RPC return types, so backend schema changes
// now reach frontend consumers without a second handwritten response model.
type ApiKeyList = Awaited<ReturnType<typeof listApiKeys>>;
type AuditLogList = Awaited<ReturnType<typeof listAuditLogs>>;
type ChatCompletionResult = Awaited<ReturnType<typeof createChatCompletion>>;
type LogList = Awaited<ReturnType<typeof listLogs>>;
type CatalogList = Awaited<ReturnType<typeof listProviders>>;
type PromptList = Awaited<ReturnType<typeof listPrompts>>;
type PromptVersionList = Awaited<ReturnType<typeof listPromptVersions>>;
type TraceList = Awaited<ReturnType<typeof listTraces>>;
type WebhookList = Awaited<ReturnType<typeof listWebhooks>>;
type WebhookOutboxList = Awaited<ReturnType<typeof listWebhookOutbox>>;
type WebhookDeliveryList = Awaited<ReturnType<typeof listWebhookDeliveries>>;

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

/** One provider and every model the catalogue holds for it. */
export type CatalogProvider = CatalogList['data'][number];
export type CatalogModel = CatalogProvider['models'][number];
export type ModelSource = CatalogModel['source'];
export type ModelStatus = CatalogModel['status'];

export type Prompt = PromptList['data'][number];

/** A row in the versions listing - everything but the template text. */
export type PromptVersionSummary = PromptVersionList['data'][number];

/** One version with its template text, from the single-version endpoint. */
export type PromptVersion = Awaited<ReturnType<typeof getPromptVersion>>;

export type RenderedPrompt = Awaited<ReturnType<typeof renderPromptVersion>>;

export type Webhook = WebhookList['data'][number];
export type CreatedWebhook = Awaited<ReturnType<typeof createWebhook>>;
export type WebhookOutboxEntry = WebhookOutboxList['data'][number];
export type WebhookDelivery = WebhookDeliveryList['data'][number];

/** One application run, as the list shows it. */
export type Trace = TraceList['data'][number];
export type TraceListMeta = TraceList['meta'];
export type TraceStatus = Trace['status'];

/** That run's summary plus its waterfall, from the single-trace endpoint. */
export type TraceDetail = Awaited<ReturnType<typeof getTrace>>;

/**
 * One row of the waterfall.
 *
 * Deliberately one type for all of them: the backend has already decided which
 * table a node came from, where it sits, and how deep it is indented.
 */
export type TraceNode = TraceDetail['nodes'][number];
export type TraceSource = TraceNode['source'];
export type TraceNodeKind = TraceNode['kind'];
export type TraceNodeStatus = TraceNode['status'];

export type ChatCompletion = ChatCompletionResult['completion'];
export type ChatCompletionChoice = ChatCompletion['choices'][number];
export type ChatCompletionUsage = ChatCompletion['usage'];
export type ChatCompletionFinishReason = ChatCompletionChoice['finish_reason'];
export type ChatCompletionToolCall = NonNullable<ChatCompletionChoice['message']['tool_calls']>[number];
