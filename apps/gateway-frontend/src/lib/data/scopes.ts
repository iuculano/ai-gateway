/** The scopes an API key can be granted, as offered in the dashboard UI. */
export interface ScopeOption {
  id: string;
  label: string;
  desc: string;
}

// Ids must match the backend's scope names exactly
// (apps/backend/src/authorization.ts SCOPES) - the API rejects keys granting
// scopes it doesn't know.
export const SCOPE_OPTIONS: ScopeOption[] = [
  { id: 'api-keys:read', label: 'API keys · Read', desc: 'List and inspect API keys' },
  { id: 'api-keys:write', label: 'API keys · Write', desc: 'Create, update, and revoke API keys' },
  { id: 'audit-logs:read', label: 'Audit logs · Read', desc: 'Read the organization audit trail' },
];
