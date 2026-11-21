import { expect, test } from 'bun:test';
import type { ApiKey, ApiKeyStats } from '../../src/lib/api/types';
import {
  CUSTOM_EXPIRY,
  type KeyForm,
  keyChanges,
  keyForm,
  keyFormError,
  keyInput,
  keyStatus,
  rateWindow,
} from '../../src/lib/data/api-keys';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const DAY_MS = 86_400_000;

const KEY = {
  id: 'key-1',
  name: 'CI deployer',
  description: null,
  scopes: 'api-keys:read logs:read',
  expires_at: null,
  revoked_at: null,
  rate_limit_requests: null,
  rate_limit_window: null,
} as ApiKey;

/**
 * A new key's form with a name on it, and whatever a test changes.
 */
function form(changes: Partial<KeyForm> = {}): KeyForm {
  return { ...keyForm(), name: 'Production server', ...changes };
}

// Status

test('a key is expired from the moment its expiry passes, and revoked wins over expired', () => {
  const lapsed = { ...KEY, expires_at: new Date(NOW).toISOString() };
  const pulled = { ...lapsed, revoked_at: new Date(NOW).toISOString() };

  expect(keyStatus(KEY, NOW)).toBe('active');
  expect(keyStatus(lapsed, NOW - 1)).toBe('active');
  expect(keyStatus(lapsed, NOW)).toBe('expired');
  expect(keyStatus(pulled, NOW)).toBe('revoked');
});

// The rate-limit window

test('a window that is counting is shown as the store reports it', () => {
  const resetsAt = new Date(Date.now() + 30_000).toISOString();
  const stats = { current_window: { used: 1200, remaining: 300, limit: 1500, resets_at: resetsAt } } as ApiKeyStats;

  const shown = rateWindow(stats, 1500);

  expect(shown).toMatchObject({ used: '1,200', remaining: '300', limit: '1,500', resetsTitle: resetsAt });
  expect(shown.resets).toStartWith('in ');
});

test('a key with no limit has nothing to count', () => {
  const shown = rateWindow({ current_window: null } as ApiKeyStats, null);

  expect(shown).toMatchObject({ used: '—', remaining: '∞', limit: 'Unlimited' });
});

test('a limited key that is idle has its whole window left, but only once the store has said so', () => {
  const before = rateWindow(null, 1500);
  const after = rateWindow({ current_window: null } as ApiKeyStats, 1500);

  expect(before).toMatchObject({ used: '—', remaining: '—', limit: '1,500' });
  expect(after).toMatchObject({ used: '0', remaining: '1,500', limit: '1,500' });
});

// Opening the dialog

test('a new key starts with read access to keys and no limit or expiry', () => {
  const blank = keyForm();

  expect(blank.scopes).toEqual({ 'api-keys:read': true });
  expect(blank.expiry).toBe('Never');
  expect(blank.rateLimitEnabled).toBe(false);
});

test('editing a key opens on its own settings', () => {
  const key = { ...KEY, expires_at: '2026-12-01T08:30:45.000Z', rate_limit_requests: 500, rate_limit_window: 60 };

  const opened = keyForm(key);

  expect(opened.scopes).toEqual({ 'api-keys:read': true, 'logs:read': true });
  expect(opened.expiry).toBe(CUSTOM_EXPIRY);
  expect(opened.rateLimitEnabled).toBe(true);
  expect(opened.rateLimitRequests).toBe(500);

  // Local time to the minute, which in the suite's zone is eight hours behind.
  expect(opened.customExpiry).toBe('2026-12-01T00:30');
});

// Checking the form

test('a key needs a name', () => {
  expect(keyFormError(form({ name: '   ' }), undefined, NOW)).toBe('Give the key a name first.');
  expect(keyFormError(form(), undefined, NOW)).toBeNull();
});

test('a custom expiry has to be a date in the future', () => {
  const problem = 'Choose an expiration date and time in the future.';

  expect(keyFormError(form({ expiry: CUSTOM_EXPIRY, customExpiry: '2026-09-09T12:00' }), undefined, NOW)).toBe(problem);
  expect(keyFormError(form({ expiry: CUSTOM_EXPIRY, customExpiry: '' }), undefined, NOW)).toBe(problem);
  expect(keyFormError(form({ expiry: CUSTOM_EXPIRY, customExpiry: '2026-09-11T12:00' }), undefined, NOW)).toBeNull();
});

test('a key that has already expired can still be edited, as long as its expiry is left alone', () => {
  const expired = { ...KEY, expires_at: '2026-09-01T08:30:45.000Z' };

  const untouched = keyForm(expired);
  const moved = { ...untouched, customExpiry: '2026-09-02T00:00' };

  expect(keyFormError(untouched, expired, NOW)).toBeNull();
  expect(keyFormError(moved, expired, NOW)).toBe('Choose an expiration date and time in the future.');
});

for (const [requests, windowSeconds] of [
  [0, 60],
  [1.5, 60],
  [100, undefined],
  [100, 2_147_483_648],
] as const) {
  test(`a rate limit of ${requests} requests per ${windowSeconds} seconds is refused`, () => {
    const limited = form({ rateLimitEnabled: true, rateLimitRequests: requests, rateLimitWindow: windowSeconds });

    expect(keyFormError(limited, undefined, NOW)).toContain('whole numbers between 1 and 2,147,483,647');
  });
}

test('a rate limit that is switched off is not checked', () => {
  const unlimited = form({ rateLimitEnabled: false, rateLimitRequests: 0, rateLimitWindow: undefined });

  expect(keyFormError(unlimited, undefined, NOW)).toBeNull();
});

// Sending the form

test('the form is sent trimmed, with only the scopes that are switched on', () => {
  const filled = form({
    name: '  Production server ',
    description: '   ',
    scopes: { 'api-keys:read': true, 'logs:read': false, 'prompts:write': true },
    rateLimitEnabled: true,
    rateLimitRequests: 500,
    rateLimitWindow: 60,
  });

  expect(keyInput(filled, undefined, NOW)).toEqual({
    name: 'Production server',
    description: null,
    scopes: 'api-keys:read prompts:write',
    expires_at: null,
    rate_limit_requests: 500,
    rate_limit_window: 60,
  });
});

test('a preset expiry counts from the moment of saving', () => {
  const input = keyInput(form({ expiry: '7 days' }), undefined, NOW);

  expect(input.expires_at).toBe(new Date(NOW + 7 * DAY_MS).toISOString());
});

test('an expiry that was not touched is sent as it is stored, seconds and all', () => {
  // The picker only holds minutes, so reading it back would move the expiry.
  const key = { ...KEY, expires_at: '2026-12-01T08:30:45.000Z' };

  const input = keyInput(keyForm(key), key, NOW);

  expect(input.expires_at).toBe('2026-12-01T08:30:45.000Z');
});

test('an edit sends only what changed, and both halves of a rate limit together', () => {
  const key = { ...KEY, rate_limit_requests: 500, rate_limit_window: 60 };
  const edited = { ...keyForm(key), name: 'Renamed', rateLimitWindow: 120 };

  const changes = keyChanges(keyInput(edited, key, NOW), key);

  expect(changes).toEqual({ name: 'Renamed', rate_limit_requests: 500, rate_limit_window: 120 });
});

test('a changed description, scope or expiry is sent', () => {
  const edited = {
    ...keyForm(KEY),
    description: 'Deploys from CI',
    scopes: { 'api-keys:read': true, 'logs:read': false },
    expiry: '30 days',
  };

  const changes = keyChanges(keyInput(edited, KEY, NOW), KEY);

  expect(changes).toEqual({
    description: 'Deploys from CI',
    scopes: 'api-keys:read',
    expires_at: new Date(NOW + 30 * DAY_MS).toISOString(),
  });
});

test('an edit that changes nothing sends nothing', () => {
  const changes = keyChanges(keyInput(keyForm(KEY), KEY, NOW), KEY);

  expect(changes).toEqual({});
});
