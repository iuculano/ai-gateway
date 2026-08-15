/**
 * Stand-in data for the analytics page.
 *
 * There is no analytics endpoint yet - the backend serves per-row logs, not
 * aggregates - so every figure here is invented. Hard-coded rather than
 * generated so the page looks identical on every render and in screenshots.
 *
 * Delete this file when the real endpoint lands; the page imports nothing else
 * from it, so the swap is one import.
 */

export interface DailyPoint {
  /** ISO date, oldest first. */
  date: string;
  requests: number;
  /** US dollars. */
  spend: number;
  /** Latency percentiles, milliseconds. */
  p50: number;
  p95: number;
  p99: number;
}

export const DAILY: DailyPoint[] = [
  { date: '2026-07-26', requests: 1180, spend: 24.1, p50: 620, p95: 1840, p99: 3120 },
  { date: '2026-07-27', requests: 1042, spend: 21.6, p50: 640, p95: 1910, p99: 3260 },
  { date: '2026-07-28', requests: 1465, spend: 30.8, p50: 610, p95: 1780, p99: 2980 },
  { date: '2026-07-29', requests: 1690, spend: 35.2, p50: 660, p95: 2010, p99: 3480 },
  { date: '2026-07-30', requests: 1584, spend: 33.4, p50: 655, p95: 1960, p99: 3390 },
  { date: '2026-07-31', requests: 1120, spend: 23.9, p50: 600, p95: 1720, p99: 2870 },
  { date: '2026-08-01', requests: 902, spend: 18.7, p50: 590, p95: 1690, p99: 2760 },
  { date: '2026-08-02', requests: 1240, spend: 26.0, p50: 630, p95: 1880, p99: 3210 },
  { date: '2026-08-03', requests: 1810, spend: 38.6, p50: 690, p95: 2140, p99: 3720 },
  { date: '2026-08-04', requests: 1975, spend: 42.3, p50: 710, p95: 2260, p99: 3980 },
  { date: '2026-08-05', requests: 1862, spend: 39.9, p50: 680, p95: 2080, p99: 3610 },
  { date: '2026-08-06', requests: 2104, spend: 45.1, p50: 700, p95: 2190, p99: 3840 },
  { date: '2026-08-07', requests: 2260, spend: 48.7, p50: 720, p95: 2240, p99: 3910 },
  { date: '2026-08-08', requests: 1994, spend: 43.2, p50: 695, p95: 2120, p99: 3680 },
];

/**
 * Provider split over the last 7 days.
 *
 * Colours are the validated categorical slots - same hue families the rest of
 * the app uses for providers, stepped into the dark-mode lightness band so they
 * clear the CVD and contrast gates on this surface. Assigned in fixed order and
 * never cycled; a seventh provider folds into "Other" rather than inventing a
 * hue.
 */
export interface ProviderSeries {
  id: string;
  label: string;
  color: string;
  /** One value per day, aligned to PROVIDER_DAYS. */
  daily: number[];
}

export const PROVIDER_DAYS = DAILY.slice(-7).map((d) => d.date);

export const PROVIDER_SPLIT: ProviderSeries[] = [
  { id: 'openai', label: 'OpenAI', color: '#059669', daily: [520, 760, 830, 790, 880, 940, 830] },
  { id: 'azure', label: 'Azure', color: '#0284c7', daily: [280, 410, 450, 420, 470, 500, 445] },
  { id: 'anthropic', label: 'Anthropic', color: '#d97706', daily: [240, 350, 385, 360, 405, 430, 380] },
  { id: 'google', label: 'Google', color: '#3b82f6', daily: [120, 175, 190, 180, 200, 215, 190] },
  { id: 'mistral', label: 'Mistral', color: '#ea580c', daily: [80, 120, 120, 112, 149, 175, 149] },
];

export interface ModelUsage {
  model: string;
  provider: string;
  requests: number;
  spend: number;
}

export const TOP_MODELS: ModelUsage[] = [
  { model: 'gpt-4o', provider: 'openai', requests: 6840, spend: 148.2 },
  { model: 'claude-3.5-sonnet', provider: 'anthropic', requests: 3120, spend: 103.4 },
  { model: 'gpt-4o-mini', provider: 'openai', requests: 2960, spend: 12.8 },
  { model: 'gemini-1.5-pro', provider: 'google', requests: 1480, spend: 31.6 },
  { model: 'mistral-large', provider: 'mistral', requests: 905, spend: 18.9 },
  { model: 'claude-3-haiku', provider: 'anthropic', requests: 640, spend: 4.2 },
];

/** Headline figures for the KPI row, over the same 14-day window. */
export const SUMMARY = {
  requests: DAILY.reduce((sum, d) => sum + d.requests, 0),
  spend: DAILY.reduce((sum, d) => sum + d.spend, 0),
  /** Mean of the daily p50s - a stand-in for a real percentile over the window. */
  medianLatencyMs: Math.round(DAILY.reduce((sum, d) => sum + d.p50, 0) / DAILY.length),
  errorRate: 1.3,
  /** Percent change against the previous window. */
  requestsDelta: 8.1,
  spendDelta: 12.4,
  latencyDelta: -4.2,
  errorRateDelta: -0.4,
};
