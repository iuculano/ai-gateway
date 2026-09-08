import { OpenAPIHono } from '@hono/zod-openapi';
import analyticsHandlers from './api/analytics/analytics.handlers';
import apiKeyHandlers from './api/api-keys/api-keys.handlers';
import auditLogHandlers from './api/audit-logs/audit-logs.handlers';
import chatCompletionHandlers from './api/chat-completions/chat-completions.handlers';
import guardrailHandlers from './api/guardrails/guardrails.handlers';
import logHandlers from './api/logs/logs.handlers';
import modelHandlers from './api/models/models.handlers';
import promptHandlers from './api/prompts/prompts.handlers';
import traceHandlers from './api/traces/traces.handlers';
import webhookHandlers from './api/webhooks/webhooks.handlers';

/**
 * See the comment on this in index.ts for why this is chained like this.
 *
 * This is split out and must remain unprefixed for the frontend.
 *
 * The frontend exposes `/api/*` and proxies it to the backend's `/v1/*`
 * instead. So, this needs to be unprefixed or the Hono client will incorrectly
 * request `/api/v1/*` instead.
 */
export const apiRoutes = new OpenAPIHono()
  .route('/', analyticsHandlers)
  .route('/', apiKeyHandlers)
  .route('/', auditLogHandlers)
  .route('/', chatCompletionHandlers)
  .route('/', guardrailHandlers)
  .route('/', logHandlers)
  .route('/', modelHandlers)
  .route('/', promptHandlers)
  .route('/', traceHandlers)
  .route('/', webhookHandlers);

export type ApiType = typeof apiRoutes;
