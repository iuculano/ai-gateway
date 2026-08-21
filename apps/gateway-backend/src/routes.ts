import { OpenAPIHono } from '@hono/zod-openapi';
import analyticsHandlers from './api/analytics/analytics.handlers';
import apiKeyHandlers from './api/api-keys/api-keys.handlers';
import auditLogHandlers from './api/audit-logs/audit-logs.handlers';
import chatCompletionHandlers from './api/chat-completions/chat-completions.handlers';
import guardrailHandlers from './api/guardrails/guardrails.handlers';
import logHandlers from './api/logs/logs.handlers';
import modelHandlers from './api/models/models.handlers';
import promptHandlers from './api/prompts/prompts.handlers';
import webhookHandlers from './api/webhooks/webhooks.handlers';

/**
 * Shared, unprefixed route tree with Hono's inferred route types intact.
 * The backend mounts it at /v1; the frontend client mounts it at /api.
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
  .route('/', webhookHandlers);

export type ApiType = typeof apiRoutes;
