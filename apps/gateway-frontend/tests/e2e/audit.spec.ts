import type { AuditLog } from '../../src/lib/api/types';
import { expect, test } from './api-mock';
import { IDS, PAGE_META } from './fixtures';

const AUDIT_LOGS = '/api/audit-logs';

// A key renamed by another key. The API key is the actor, and actor_name is
// the person who owns it.
const RENAMED = {
  id: '0198f100-0000-7000-8000-00000000a001',
  actor_type: 'api_key',
  actor_id: IDS.apiKey,
  actor_name: 'Ada Lovelace',
  actor_email: 'ada@example.com',
  actor_api_key_name: 'CI deployer',
  event: 'api-keys.updated',
  target_type: 'api_key',
  target_id: '0198f100-0000-7000-8000-00000000a002',
  status: 'success',
  metadata: { name: 'deploy' },
  difference: { name: { old: 'ci', new: 'deploy' } },
  occurred_at: null,
  created_at: '2026-10-03T12:00:00.000Z',
  request_id: null,
  ip: '203.0.113.7',
  user_agent: null,
} as AuditLog;

test('an event is listed by who acted, what they did and what it was done to', async ({ page, api }) => {
  api.get(AUDIT_LOGS, { json: { data: [RENAMED], meta: PAGE_META } });
  const row = page.getByRole('button', { expanded: false }).filter({ hasText: 'api-keys.updated' });

  await page.goto('/audit');

  // The key's own name and not its owner's, and the time it was recorded,
  // since nothing says it happened earlier.
  await expect(row).toContainText('CI deployer');
  await expect(row).not.toContainText('Ada Lovelace');
  await expect(row).toContainText(/Oct 3 ·\s*12:00:00/);
  await expect(row).toContainText('deploy');
  await expect(row).toContainText('API Keys');
  await expect(row).toContainText('203.0.113.7');
});

test('opening an event shows what changed, and says so when a detail was never recorded', async ({ page, api }) => {
  api.get(AUDIT_LOGS, { json: { data: [RENAMED], meta: PAGE_META } });
  const main = page.getByRole('main');

  await page.goto('/audit');
  await page.getByRole('button', { expanded: false }).filter({ hasText: 'api-keys.updated' }).click();

  await expect(main.getByText('ci', { exact: true })).toBeVisible();
  await expect(main.getByText('Actor · API key', { exact: true })).toBeVisible();
  await expect(main.getByText('2026-10-03 12:00:00 UTC', { exact: true })).toHaveCount(2);

  // No request id and no user agent were stored for this one.
  await expect(main.getByText('Request ID', { exact: true }).locator('..')).toContainText('—');
  await expect(main.getByText('User agent', { exact: true }).locator('..')).toContainText('System');
});
