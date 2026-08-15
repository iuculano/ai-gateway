import type { AuditLog } from '$lib/api/types';
import type { AuditCategory, AuditChange, AuditEvent } from './types';

// Event names are '<area>.<action>' (e.g. 'api-keys.revoked'); the area maps
// onto the page's category filter pills.
const EVENT_CATEGORIES: Record<string, AuditCategory> = {
  'api-keys': 'keys',
  auth: 'auth',
  members: 'members',
  billing: 'billing',
  settings: 'settings',
  security: 'security',
};

const ACTOR_TONES = ['#10b981', '#60a5fa', '#c084fc', '#f59e0b', '#2dd4bf', '#f472b6'];

/** Deterministic color per actor so the same actor always renders the same. */
function toneFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return ACTOR_TONES[hash % ACTOR_TONES.length];
}

function categoryOf(event: string): AuditCategory {
  return EVENT_CATEGORIES[event.split('.')[0]] ?? 'settings';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuditChange(value: unknown): value is AuditChange {
  return isRecord(value) && 'old' in value && 'new' in value;
}

function toAuditChanges(value: unknown): Record<string, AuditChange> | undefined {
  if (!isRecord(value)) return undefined;

  const changes: Record<string, AuditChange> = {};
  for (const [field, change] of Object.entries(value)) {
    if (!isAuditChange(change)) return undefined;
    changes[field] = change;
  }
  return changes;
}

/**
 * Maps a backend audit log row to the view model the audit table renders.
 *
 * The backend resolves actor_id to a display name; the shortened-id label
 * only remains as the fallback for actors that no longer exist.
 */
export function toAuditEvent(log: AuditLog): AuditEvent {
  const shortActor = log.actor_id ? log.actor_id.slice(0, 8) : null;

  const actorName =
    log.actor_type === 'system'
      ? 'System'
      : (log.actor_name ?? `${log.actor_type === 'api_key' ? 'Key' : 'User'} ${shortActor ?? 'unknown'}`);

  // The metadata JSON tab shows everything we know about the event; the
  // field-level diff arrives separately as `difference` and the row component
  // reads it from metadata.changes.
  const metadata: AuditEvent['metadata'] = isRecord(log.metadata) ? { ...log.metadata } : {};
  const changes = toAuditChanges(log.difference);
  if (changes && Object.keys(changes).length > 0) {
    metadata.changes = changes;
  }

  const metadataName = isRecord(log.metadata) ? log.metadata.name : undefined;
  const targetLabel = typeof metadataName === 'string' ? metadataName : (log.target_id?.slice(0, 8) ?? '');

  return {
    id: log.id,
    occurredAt: log.occurred_at ?? log.created_at,
    createdAt: log.created_at,
    actorType: log.actor_type,
    actorId: log.actor_id,
    actorName: actorName,
    actorEmail: log.actor_email,
    initials: actorName ? actorName.slice(0, 2).toUpperCase() : '·',
    actorTone: toneFor(log.actor_id ?? 'system'),
    action: log.event,
    targetType: log.target_type,
    targetId: log.target_id,
    targetLabel: targetLabel,
    cat: categoryOf(log.event),
    status: log.status,
    requestId: log.request_id ?? '—',
    ip: log.ip,
    userAgent: log.user_agent ?? '',
    metadata: metadata,
  };
}
