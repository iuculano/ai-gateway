export type Env = 'live' | 'test';
export type KeyStatus = 'active' | 'revoked';

export interface ApiKey {
  id: string;
  name: string;
  desc: string;
  env: Env;
  prefix: string;
  tail: string;
  created: string;
  lastUsed: string;
  createdBy: string;
  requests30: number;
  status: KeyStatus;
  scopes: string[];
  rateLimit: string;
  burst: string;
  quotaUsed: number;
  quotaTotal: string;
  tone: string;
  usage: number[];
}

export interface Scope {
  id: string;
  label: string;
  desc: string;
}

export type AuditActorType = 'user' | 'api_key' | 'system';
export type AuditCategory = 'auth' | 'keys' | 'members' | 'billing' | 'settings' | 'security';

export interface AuditChange {
  old: unknown;
  new: unknown;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  createdAt: string;
  actorType: AuditActorType;
  actorId: string | null;
  actorName: string;
  actorEmail: string | null;
  initials: string;
  actorTone: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string;
  cat: AuditCategory;
  status: 'success' | 'failure';
  requestId: string;
  ip: string | null;
  userAgent: string;
  metadata: Record<string, unknown> & { changes?: Record<string, AuditChange> };
}
