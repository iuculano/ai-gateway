import { expect, test } from 'bun:test';
import type { AuditLog } from '../../src/lib/api/types';
import { auditSummary, toAuditEvent } from '../../src/lib/data/audit';

function log(fields: Partial<AuditLog>): AuditLog {
  return {
    id: '0198f100-0000-7000-8000-000000000001',
    actor_type: 'user',
    actor_id: '0198f100-0000-7000-8000-000000000002',
    actor_name: 'Ada Lovelace',
    actor_email: 'ada@example.com',
    actor_api_key_name: null,
    event: 'api-keys.revoked',
    target_type: 'api_key',
    target_id: '0198f100-0000-7000-8000-000000000003',
    status: 'success',
    metadata: null,
    difference: null,
    occurred_at: null,
    created_at: '2026-10-03T12:00:00.000Z',
    request_id: null,
    ip: null,
    user_agent: null,
    ...fields,
  } as AuditLog;
}

test('an event is filed under the category its name starts with', () => {
  expect(toAuditEvent(log({ event: 'api-keys.revoked' })).cat).toBe('keys');
  expect(toAuditEvent(log({ event: 'auth.login' })).cat).toBe('auth');
});

test('an API key is named by its own name, not its owner’s', () => {
  const event = toAuditEvent(
    log({ actor_type: 'api_key', actor_name: 'Ada Lovelace', actor_api_key_name: 'CI deployer' }),
  );

  expect(event.actorLabel).toBe('CI deployer');
});

test('an actor whose name is gone is still named for what it was', () => {
  const event = toAuditEvent(log({ actor_type: 'api_key', actor_name: null, actor_api_key_name: null }));

  expect(event.actorLabel).toBe('Unknown API key');
});

test('a stored diff is shown as field changes, and anything else is left out', () => {
  const renamed = toAuditEvent(log({ difference: { name: { old: 'ci', new: 'deploy' } } }));
  const malformed = toAuditEvent(log({ difference: { name: 'deploy' } }));

  expect(renamed.metadata.changes).toEqual({ name: { old: 'ci', new: 'deploy' } });
  expect(malformed.metadata.changes).toBeUndefined();
});

test('the target is labelled by its name when the event recorded one', () => {
  const named = toAuditEvent(log({ metadata: { name: 'CI deployer' } }));
  const unnamed = toAuditEvent(log({ metadata: null }));

  expect(named.targetLabel).toBe('CI deployer');
  expect(unnamed.targetLabel).toBe('0198f100');
});

test("the summary counts today by the reader's own day, with the actors and failures on show", () => {
  // Seven in the evening on the first of September, in the suite's zone. In
  // UTC it is already the second.
  const now = new Date('2026-09-02T02:00:00.000Z');
  const events = [
    log({ created_at: '2026-09-01T20:00:00.000Z', actor_id: 'ada', status: 'failure' }),
    log({ created_at: '2026-09-02T01:30:00.000Z', actor_id: 'ada' }),
    log({ created_at: '2026-09-01T06:00:00.000Z', actor_id: 'grace' }),
  ].map(toAuditEvent);

  const summary = auditSummary(events, now);

  // The third was late the evening before, by the reader's clock.
  expect(summary).toEqual({ today: 2, actors: 2, failures: 1 });
});
