import { getContext, setContext } from 'svelte';

const DAY_MS = 86_400_000;

// 30 days is the default. The window has to be wide enough that the shape of a
// workload shows, and a fortnight of a bursty gateway is mostly noise.
const DEFAULT_RANGE = { id: '30d' as const, label: 'Last 30 days', days: 30, interval: 'day' as const };

export const RANGES = [
  { id: '24h' as const, label: 'Last 24 hours', days: 1, interval: 'hour' as const },
  { id: '7d' as const, label: 'Last 7 days', days: 7, interval: 'day' as const },
  { id: '14d' as const, label: 'Last 14 days', days: 14, interval: 'day' as const },
  DEFAULT_RANGE,
];

/**
 * The range and filters every analytics tab shares. The analytics layout holds
 * them, so switching tabs keeps what was picked.
 */
export class AnalyticsFilters {
  rangeId = $state<(typeof RANGES)[number]['id']>(DEFAULT_RANGE.id);
  provider = $state('');
  model = $state('');
  range = $derived(RANGES.find((range) => range.id === this.rangeId) ?? DEFAULT_RANGE);
}

const KEY = Symbol('analytics-filters');

export function setAnalyticsFilters(): AnalyticsFilters {
  return setContext(KEY, new AnalyticsFilters());
}

export function getAnalyticsFilters(): AnalyticsFilters {
  return getContext(KEY);
}

/**
 * Now, rounded down to 30 seconds, so that repeat loads send identical queries
 * and the server can answer them from cache. Nothing is lost, because logs
 * reach analytics only once they are 30 seconds old.
 */
export function alignedNow(): number {
  return Math.floor(Date.now() / 30_000) * 30_000;
}

/**
 * The last so many days up to now, as the dates a request asks about.
 */
export function windowOf(days: number): { start_date: string; end_date: string } {
  const end = alignedNow();

  return {
    start_date: new Date(end - days * DAY_MS).toISOString(),
    end_date: new Date(end).toISOString(),
  };
}

/**
 * The equally long window before the last so many days, which is what they
 * are compared against. It ends on a 5-minute mark. Its query then changes
 * only every 5 minutes, and since its data no longer changes, the server's
 * cache can answer it until then.
 */
export function windowBefore(days: number): { start_date: string; end_date: string } {
  const duration = days * DAY_MS;
  const end = Math.floor((alignedNow() - duration) / 300_000) * 300_000;

  return {
    start_date: new Date(end - duration).toISOString(),
    end_date: new Date(end).toISOString(),
  };
}
