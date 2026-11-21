import type { SeriesPoint } from '#lib/api/analytics.ts';

const NEUTRAL = '#a1a1aa';
const WARNING = '#fbbf24';
const GOOD = '#34d399';
const INFORMATIVE = '#60a5fa';

type Comparison = ReturnType<typeof periodComparison>;
type HeadlineFigure = 'requests' | 'tokens' | 'spend' | 'averageCost' | 'latency' | 'errorRate';

/**
 * The figures across the top of the analytics page, for one window.
 */
export interface Headline {
  requests: number;
  tokens: number;
  spend: number;

  /**
   * Dollars per request, or null for a window with no requests.
   */
  averageCost: number | null;
  latency: number | null;

  /**
   * Percentages of every request, or null for a window with no requests.
   */
  errorRate: number | null;
  inFlightRate: number | null;
}

interface ComparisonOptions {
  /**
   * The period being compared against, as it reads in a sentence.
   */
  label: string;
  lowerIsBetter?: boolean;
}

/**
 * How a figure moved against the period before, as a short label, a colour for
 * it and a sentence for the tooltip.
 */
export function periodComparison(
  current: number | null,
  previous: number | null,
  options: ComparisonOptions,
): { text: string; color: string; title: string } {
  // A rise is a warning where lower is better, and only worth noting otherwise.
  const increaseColor = options.lowerIsBetter ? WARNING : INFORMATIVE;
  const decreaseColor = options.lowerIsBetter ? GOOD : WARNING;

  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { text: 'No prior data', color: NEUTRAL, title: `No comparable data for ${options.label}.` };
  }

  if (previous === 0 && current !== 0) {
    const title = `Up from zero in ${options.label}; percentage change is undefined.`;

    return { text: 'New', color: increaseColor, title: title };
  }

  // Zero against zero is no change, and anything else against zero was
  // answered above.
  const change = previous === 0 ? 0 : ((current - previous) / previous) * 100;
  const amount = Number(Math.abs(change).toFixed(1));
  const magnitude = `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

  const previousValue = previous.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const title = `Percentage change versus ${options.label}. Previous value: ${previousValue}.`;

  if (amount === 0) {
    return { text: magnitude, color: NEUTRAL, title: title };
  }

  if (change > 0) {
    return { text: `↑ ${magnitude}`, color: increaseColor, title: title };
  }

  return { text: `↓ ${magnitude}`, color: decreaseColor, title: title };
}

function requestsWithStatus(statuses: SeriesPoint[], status: SeriesPoint['status']): number {
  return statuses.find((point) => point.status === status)?.requests ?? 0;
}

/**
 * One window's headline figures.
 *
 * @param totals
 * The window as a single row, or null when it came back empty.
 *
 * @param statuses
 * The same window grouped by status.
 */
export function headlineFigures(totals: SeriesPoint | null, statuses: SeriesPoint[]): Headline {
  const requests = totals?.requests ?? 0;
  const spend = totals?.cost_total ?? 0;
  const hasRequests = requests > 0;

  // The error rate is failed over all requests, and not everything that is
  // not complete. A row is written before the provider is called, so the
  // in-flight ones have not gone wrong. Counting them would inflate the rate
  // when concurrency is highest, which is when someone reads it in an incident.
  const failed = requestsWithStatus(statuses, 'failed');
  const inFlight = requestsWithStatus(statuses, 'incomplete');

  return {
    requests: requests,
    tokens: totals?.total_tokens ?? 0,
    spend: spend,
    averageCost: hasRequests ? spend / requests : null,
    latency: totals?.median_latency_ms ?? null,
    errorRate: hasRequests ? (failed / requests) * 100 : null,
    inFlightRate: hasRequests ? (inFlight / requests) * 100 : null,
  };
}

/**
 * How each headline figure moved against the window before.
 *
 * @param current
 * This window's figures.
 *
 * @param previous
 * The window before, or null when it had no data.
 *
 * @param label
 * The window before, as it reads in a sentence.
 */
export function headlineComparisons(
  current: Headline,
  previous: Headline | null,
  label: string,
): Record<HeadlineFigure, Comparison> {
  const volume = { label: label };
  const cost = { label: label, lowerIsBetter: true };

  return {
    requests: periodComparison(current.requests, previous?.requests ?? null, volume),
    tokens: periodComparison(current.tokens, previous?.tokens ?? null, volume),
    spend: periodComparison(current.spend, previous?.spend ?? null, cost),
    averageCost: periodComparison(current.averageCost, previous?.averageCost ?? null, cost),
    latency: periodComparison(current.latency, previous?.latency ?? null, cost),
    errorRate: periodComparison(current.errorRate, previous?.errorRate ?? null, cost),
  };
}

/**
 * What every headline figure shows when the window before failed to load.
 */
export function unavailableComparisons(label: string): Record<HeadlineFigure, Comparison> {
  const unavailable = { text: 'Unavailable', color: NEUTRAL, title: `Could not load ${label}.` };

  return {
    requests: unavailable,
    tokens: unavailable,
    spend: unavailable,
    averageCost: unavailable,
    latency: unavailable,
    errorRate: unavailable,
  };
}
