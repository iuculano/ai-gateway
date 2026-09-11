import { OpenAPIHono } from '@hono/zod-openapi';
import actorHandlers from './api/actors/actors.handlers';
import analyticsHandlers from './api/analytics/analytics.handlers';
import apiKeyHandlers from './api/api-keys/api-keys.handlers';
import auditLogHandlers from './api/audit-logs/audit-logs.handlers';
import chatCompletionHandlers from './api/chat-completions/chat-completions.handlers';
import guardrailHandlers from './api/guardrails/guardrails.handlers';
import healthHandlers from './api/health/health.handlers';
import logHandlers from './api/logs/logs.handlers';
import modelHandlers from './api/models/models.handlers';
import promptHandlers from './api/prompts/prompts.handlers';
import traceHandlers from './api/traces/traces.handlers';
import webhookHandlers from './api/webhooks/webhooks.handlers';

// These are split out and must remain unprefixed for the frontend.
//
// For example, the frontend exposes `/api/*` and proxies it to the backend's
// `/v1/*` instead. So, this needs to be unprefixed or the Hono client will
// incorrectly wind up trying to use `/api/v1/*` instead.
//
// Keep these route groups unprefixed. The backend chooses their mount paths,
// and frontend clients choose the base URLs used with the exported types.

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

// biome-ignore format: looks nicer
export const healthRoutes = new OpenAPIHono()
  .route('/', healthHandlers);

// biome-ignore format: looks nicer
export const internalRoutes = new OpenAPIHono()
  .route('/', actorHandlers);

export type ApiType = typeof apiRoutes;
export type HealthApiType = typeof healthRoutes;
export type InternalApiType = typeof internalRoutes;
