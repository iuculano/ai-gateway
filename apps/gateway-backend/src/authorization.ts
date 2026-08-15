/**
 * List of scopes for the API.
 */
export const SCOPES = {
  apiKeysRead: 'api-keys:read',
  apiKeysWrite: 'api-keys:write',
  auditLogsRead: 'audit-logs:read',
  chatCompletionsWrite: 'chat-completions:write',
  guardrailsRead: 'guardrails:read',
  guardrailsWrite: 'guardrails:write',
  logsRead: 'logs:read',
  logsWrite: 'logs:write',
  modelsRead: 'models:read',
  modelsWrite: 'models:write',
  webhooksRead: 'webhooks:read',
  webhooksWrite: 'webhooks:write',
} as const;

/**
 * Mapping of roles to the scopes they grant.
 *
 * The API uses fine-grained scopes internally. Lets you assign more easy to
 * reason about roles to users on the IDP rather than fumbling with scopes claim
 * wise.
 */
export const ROLE_SCOPES_MAP: Record<string, string[]> = {
  admin: Object.values(SCOPES), // Everything
  // guardrailsRead, not Write: reading the rules and running them against
  // content is ordinary use, but changing what the gateway will refuse is an
  // administrative act.
  //
  // modelsRead, not Write, for the same reason and one more: `models` is a
  // single global catalogue with no organization_id, so a write there is not
  // scoped to the caller's tenant the way every other write in this API is. It
  // also carries the per-token costs, which is to say the billing inputs.
  user: [
    SCOPES.apiKeysRead,
    SCOPES.auditLogsRead,
    SCOPES.chatCompletionsWrite,
    SCOPES.guardrailsRead,
    SCOPES.logsRead,
    SCOPES.modelsRead,
    SCOPES.webhooksRead,
  ],
};
