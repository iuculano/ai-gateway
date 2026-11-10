import { getContext, setContext } from 'svelte';

// 30 days is the default: the window has to be wide enough that the shape of a
// workload is visible, and a fortnight of a bursty gateway is mostly noise.
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
 * Now, rounded down to 30 s, so repeat loads send identical queries that the
 * server can answer from cache. Loses nothing: logs reach analytics only once
 * they're 30 s old.
 */
export function alignedNow() {
  return Math.floor(Date.now() / 30_000) * 30_000;
}
