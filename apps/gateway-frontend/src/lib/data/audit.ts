import type { AuditActorType, AuditLog } from '#lib/api/types.ts';
import { toneFor } from '#lib/data/format.ts';

export type AuditCategory = 'auth' | 'keys' | 'members' | 'billing' | 'settings' | 'security';

export interface AuditChange {
  old: unknown;
  new: unknown;
}

/**
 * An audit log row with what the table works out from it.
 */
export type AuditEvent = Omit<AuditLog, 'metadata'> & {
  /**
   * Who acted, by the name they are shown under.
   */
  actorLabel: string;
  actorTone: string;
  targetLabel: string;
  cat: AuditCategory;
  metadata: Record<string, unknown> & { changes?: Record<string, AuditChange> };
};

// Event names are '<area>.<action>', such as 'api-keys.revoked'. The area
// picks the category pill the event is filed under.
const EVENT_CATEGORIES: Record<string, AuditCategory> = {
  'api-keys': 'keys',
  auth: 'auth',
  members: 'members',
  billing: 'billing',
  settings: 'settings',
  security: 'security',
};

const UNNAMED_ACTORS: Record<AuditActorType, string> = {
  unknown: 'Unknown actor',
  user: 'Unknown user',
  api_key: 'Unknown API key',
  system: 'System',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuditChange(value: unknown): value is AuditChange {
  return isRecord(value) && 'old' in value && 'new' in value;
}

/**
 * The stored diff as field changes, or undefined when it is not one.
 */
function toAuditChanges(value: unknown): Record<string, AuditChange> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const changes: Record<string, AuditChange> = {};

  for (const [field, change] of Object.entries(value)) {
    if (!isAuditChange(change)) {
      return undefined;
    }

    changes[field] = change;
  }

  return changes;
}

/**
 * Adds to a backend audit log row what the audit table works out from it.
 */
export function toAuditEvent(log: AuditLog): AuditEvent {
  // An API key is labelled by its own name. actor_name is its owner there.
  const actorName = log.actor_type === 'api_key' ? log.actor_api_key_name : log.actor_name;

  // The metadata tab shows everything known about the event. The field-level
  // diff is stored apart from it, and the row reads it from metadata.changes.
  const metadata: AuditEvent['metadata'] = isRecord(log.metadata) ? { ...log.metadata } : {};
  const changes = toAuditChanges(log.difference);

  if (changes && Object.keys(changes).length > 0) {
    metadata.changes = changes;
  }

  const area = log.event.split('.')[0];
  const name = metadata.name;
  const targetLabel = typeof name === 'string' ? name : (log.target_id?.slice(0, 8) ?? '');

  return {
    ...log,
    actorLabel: actorName ?? UNNAMED_ACTORS[log.actor_type],
    actorTone: toneFor(log.actor_id),
    targetLabel: targetLabel,
    cat: EVENT_CATEGORIES[area] ?? 'settings',
    metadata: metadata,
  };
}

/**
 * What the toolbar says about the events on show, which is how many happened
 * today, how many actors were behind them, and how many failed.
 */
export function auditSummary(events: AuditEvent[], now: Date): { today: number; actors: number; failures: number } {
  // Today is the reader's own day. Compared as UTC dates, an event from this
  // afternoon would stop counting as today once it was past midnight in UTC.
  const today = now.toDateString();
  const actors = new Set<string>();
  let todayCount = 0;
  let failures = 0;

  for (const event of events) {
    if (new Date(event.created_at).toDateString() === today) {
      todayCount += 1;
    }

    if (event.actor_id) {
      actors.add(event.actor_id);
    }

    if (event.status === 'failure') {
      failures += 1;
    }
  }

  return { today: todayCount, actors: actors.size, failures: failures };
}
