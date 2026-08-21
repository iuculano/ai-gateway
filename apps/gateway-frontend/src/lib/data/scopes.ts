/** The scopes an API key can be granted, as offered in the dashboard UI. */
export interface ScopeOption {
  id: string;
  label: string;
  desc: string;
}

// Ids must match the backend's scope names exactly
// (apps/gateway-backend/src/authorization.ts SCOPES) - the API rejects keys
// granting scopes it doesn't know. Kept in the same order the backend declares
// them so the two lists can be diffed by eye.
//
// Note that api-keys:write is additionally gated on actorTypes: ['user'], so
// granting it to a key buys that key nothing - every route it guards rejects
// api-key actors. It stays listed because the same options drive the UI for
// user-held permissions.
export const SCOPE_OPTIONS: ScopeOption[] = [
  { id: 'api-keys:read', label: 'API keys · Read', desc: 'List and inspect API keys' },
  { id: 'api-keys:write', label: 'API keys · Write', desc: 'Create, update, and revoke API keys' },
  { id: 'audit-logs:read', label: 'Audit logs · Read', desc: 'Read the organization audit trail' },
  {
    id: 'chat-completions:write',
    label: 'Chat completions · Write',
    desc: 'Send inference requests through the gateway',
  },
  {
    id: 'guardrails:read',
    label: 'Guardrails · Read',
    desc: 'List guardrails and evaluate content against them',
  },
  {
    id: 'guardrails:write',
    label: 'Guardrails · Write',
    desc: 'Create, update, and delete guardrails',
  },
  { id: 'logs:read', label: 'Logs · Read', desc: 'Read request logs, payloads, and analytics' },
  { id: 'logs:write', label: 'Logs · Write', desc: 'Delete request logs' },
  { id: 'models:read', label: 'Models · Read', desc: 'List and inspect configured models' },
  { id: 'models:write', label: 'Models · Write', desc: 'Add, update, and remove models' },
  { id: 'prompts:read', label: 'Prompts · Read', desc: 'List and inspect stored prompts' },
  { id: 'prompts:write', label: 'Prompts · Write', desc: 'Create, update, and delete prompts' },
  {
    id: 'webhooks:read',
    label: 'Webhooks · Read',
    desc: 'List webhooks and inspect delivery history',
  },
  {
    id: 'webhooks:write',
    label: 'Webhooks · Write',
    desc: 'Create, update, and delete webhooks',
  },
];
