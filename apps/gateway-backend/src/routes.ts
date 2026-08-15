import { OpenAPIHono } from '@hono/zod-openapi';
import analyticsHandlers from './api/analytics/analytics.handlers';
import apiKeyHandlers from './api/api-keys/api-keys.handlers';
import auditLogHandlers from './api/audit-logs/audit-logs.handlers';
import chatCompletionHandlers from './api/chat-completions/chat-completions.handlers';
import guardrailHandlers from './api/guardrails/guardrails.handlers';
import logHandlers from './api/logs/logs.handlers';
import modelHandlers from './api/models/models.handlers';
import webhookHandlers from './api/webhooks/webhooks.handlers';

/**
 * Routes mounted below /v1 by the backend and below /api by the frontend.
 */
export const apiRoutes = new OpenAPIHono()
  .route('/', analyticsHandlers)
  .route('/', apiKeyHandlers)
  .route('/', auditLogHandlers)
  .route('/', chatCompletionHandlers)
  .route('/', guardrailHandlers)
  .route('/', logHandlers)
  .route('/', modelHandlers)
  .route('/', webhookHandlers);

export type ApiType = typeof apiRoutes;
