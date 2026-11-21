import type { UpdateApiKeyInput } from '#lib/api/api-keys.ts';
import type { ApiKey, ApiKeyStats } from '#lib/api/types.ts';
import { timeUntil } from '#lib/data/format.ts';

const DAY_MS = 86_400_000;

// A rate limit's two fields are 32-bit integers in the database.
const LARGEST_COUNT = 2_147_483_647;

export const NEVER = 'Never';
export const CUSTOM_EXPIRY = 'Custom date & time';

// How many days a key lasts under each choice the dialog offers. The two with
// no length are never, and a date picked by hand.
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  [NEVER]: null,
  '1 day': 1,
  '7 days': 7,
  '30 days': 30,
  '90 days': 90,
  '1 year': 365,
  [CUSTOM_EXPIRY]: null,
};

export type KeyStatus = 'active' | 'expired' | 'revoked';

/**
 * What the key dialog's fields hold.
 */
export interface KeyForm {
  name: string;
  description: string;
  scopes: Record<string, boolean>;

  /**
   * One of the labels in `EXPIRY_OPTIONS`.
   */
  expiry: string;

  /**
   * A local date and time to the minute, as a datetime-local input holds it.
   */
  customExpiry: string;
  rateLimitEnabled: boolean;
  rateLimitRequests: number | undefined;
  rateLimitWindow: number | undefined;
}

/**
 * The form as the fields the API takes.
 */
export interface KeyInput {
  name: string;
  description: string | null;
  scopes: string;
  expires_at: string | null;
  rate_limit_requests: number | null;
  rate_limit_window: number | null;
}

/**
 * The live rate-limit window, as a key's row shows it.
 */
export interface RateWindow {
  used: string;
  remaining: string;
  limit: string;
  resets: string;
  resetsTitle: string | undefined;
}

/**
 * Where a key stands. A revoked key reads as revoked even once it has expired.
 */
export function keyStatus(key: ApiKey, now: number): KeyStatus {
  if (key.revoked_at !== null) {
    return 'revoked';
  }

  return key.expires_at !== null && new Date(key.expires_at).getTime() <= now ? 'expired' : 'active';
}

/**
 * The window a key's requests are being counted in.
 *
 * @param stats
 * The key's usage, or null before it has been fetched, when a zero cannot be
 * shown yet.
 *
 * @param limit
 * The requests the key is allowed in one window, or null when it has no limit.
 */
export function rateWindow(stats: ApiKeyStats | null, limit: number | null): RateWindow {
  const live = stats?.current_window;

  if (live) {
    return {
      used: live.used.toLocaleString(),
      remaining: live.remaining.toLocaleString(),
      limit: live.limit.toLocaleString(),
      resets: `in ${timeUntil(live.resets_at)}`,
      resetsTitle: live.resets_at,
    };
  }

  // No window comes back for a key with no limit, or for a limited key whose
  // counter is not running. Both are answered from the key's own settings, so
  // that the section never collapses to nothing.
  if (limit === null) {
    return { used: '—', remaining: '∞', limit: 'Unlimited', resets: '—', resetsTitle: undefined };
  }

  // A limited key with no counter running has spent nothing of its next
  // window. That is a claim about the store, so it is dashes until the store
  // has been asked.
  return {
    used: stats ? '0' : '—',
    remaining: stats ? limit.toLocaleString() : '—',
    limit: limit.toLocaleString(),
    resets: '—',
    resetsTitle: undefined,
  };
}

/**
 * An instant as a datetime-local input holds it, in local time to the minute.
 */
function localDateTime(iso: string): string {
  const date = new Date(iso);

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * What the dialog opens with, which is a key's own settings when one is being
 * edited and the defaults for a new key otherwise.
 */
export function keyForm(key?: ApiKey): KeyForm {
  const scopes: Record<string, boolean> = {};

  // Scopes travel as one string with spaces between them.
  for (const scope of (key?.scopes ?? 'api-keys:read').split(' ')) {
    if (scope) {
      scopes[scope] = true;
    }
  }

  return {
    name: key?.name ?? '',
    description: key?.description ?? '',
    scopes: scopes,
    expiry: key?.expires_at ? CUSTOM_EXPIRY : NEVER,
    customExpiry: key?.expires_at ? localDateTime(key.expires_at) : '',
    rateLimitEnabled: key?.rate_limit_requests != null,
    rateLimitRequests: key?.rate_limit_requests ?? 100,
    rateLimitWindow: key?.rate_limit_window ?? 60,
  };
}

/**
 * Whether an edit leaves the key's expiry as it is.
 */
function keepsExpiry(form: KeyForm, original: ApiKey | undefined): boolean {
  if (!original) {
    return false;
  }

  if (original.expires_at === null) {
    return form.expiry === NEVER;
  }

  return form.expiry === CUSTOM_EXPIRY && form.customExpiry === localDateTime(original.expires_at);
}

/**
 * When the form says the key should expire, or null for never.
 */
function chosenExpiry(form: KeyForm, now: number): Date | null {
  if (form.expiry === CUSTOM_EXPIRY) {
    return new Date(form.customExpiry);
  }

  const days = EXPIRY_OPTIONS[form.expiry];

  return days ? new Date(now + days * DAY_MS) : null;
}

function isCount(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= LARGEST_COUNT;
}

/**
 * What is wrong with the form, as a sentence for the reader, or null when it
 * can be saved.
 */
export function keyFormError(form: KeyForm, original: ApiKey | undefined, now: number): string | null {
  if (!form.name.trim()) {
    return 'Give the key a name first.';
  }

  // An expiry that was left alone is not checked, so that a key which has
  // already expired can still be renamed.
  const expiresAt = keepsExpiry(form, original) ? null : chosenExpiry(form, now);

  // Written so that a date that could not be read fails it too.
  if (expiresAt && !(expiresAt.getTime() > now)) {
    return 'Choose an expiration date and time in the future.';
  }

  if (form.rateLimitEnabled && !(isCount(form.rateLimitRequests) && isCount(form.rateLimitWindow))) {
    return 'Enter whole numbers between 1 and 2,147,483,647 for requests and window seconds.';
  }

  return null;
}

/**
 * The form as the fields the API takes.
 */
export function keyInput(form: KeyForm, original: ApiKey | undefined, now: number): KeyInput {
  const granted: string[] = [];

  for (const [scope, isGranted] of Object.entries(form.scopes)) {
    if (isGranted) {
      granted.push(scope);
    }
  }

  // The picker only goes to the minute, so an expiry that was left alone is
  // sent as it is stored and not read back off the form.
  const expiresAt = keepsExpiry(form, original)
    ? (original?.expires_at ?? null)
    : (chosenExpiry(form, now)?.toISOString() ?? null);

  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    scopes: granted.join(' '),
    expires_at: expiresAt,
    rate_limit_requests: form.rateLimitEnabled ? Number(form.rateLimitRequests) : null,
    rate_limit_window: form.rateLimitEnabled ? Number(form.rateLimitWindow) : null,
  };
}

/**
 * The fields of an edit that differ from the key as it is.
 */
export function keyChanges(input: KeyInput, original: ApiKey): UpdateApiKeyInput {
  const changes: UpdateApiKeyInput = {};

  if (input.name !== original.name) {
    changes.name = input.name;
  }

  if (input.description !== original.description) {
    changes.description = input.description;
  }

  if (input.scopes !== original.scopes) {
    changes.scopes = input.scopes;
  }

  if (input.expires_at !== original.expires_at) {
    changes.expires_at = input.expires_at;
  }

  // The two halves of a rate limit only mean something together, so a change
  // to either sends both.
  if (
    input.rate_limit_requests !== original.rate_limit_requests ||
    input.rate_limit_window !== original.rate_limit_window
  ) {
    changes.rate_limit_requests = input.rate_limit_requests;
    changes.rate_limit_window = input.rate_limit_window;
  }

  return changes;
}
