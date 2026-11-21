import type { SeriesPoint } from '#lib/api/analytics.ts';

export type ModelChangeMetric = 'cost_total' | 'requests';
export type ModelSortKey =
  | 'model'
  | 'requests'
  | 'spend'
  | 'averageCost'
  | 'latency'
  | 'errorRate'
  | 'costPerMillion'
  | 'tokensPerRequest'
  | 'inputShare';

/**
 * One model's cost, efficiency, latency and failure rate. A figure is null
 * when the model had nothing to work it out from.
 */
export interface ModelComparisonRow {
  id: string;
  model: string;
  provider: string;
  requests: number;
  spend: number;
  costPerMillion: number | null;
  tokensPerRequest: number | null;
  inputTokens: number;
  outputTokens: number;
  inputShare: number | null;
  averageCost: number | null;
  latency: number | null;
  errorRate: number | null;
}

/**
 * How one model's spend or traffic moved between two windows.
 */
export interface ModelChangeRow {
  id: string;
  model: string;
  provider: string;
  current: number;
  previous: number;
  change: number;

  /**
   * Null when the model went up from nothing, which has no percentage.
   */
  percentage: number | null;
}

/**
 * Identifies a model on a provider. The same name on two providers is two
 * models.
 */
function modelKey(point: SeriesPoint): string {
  return JSON.stringify([point.provider, point.model]);
}

function percentageOf(change: number, previous: number, current: number): number | null {
  if (previous > 0) {
    return (change / previous) * 100;
  }

  // Up from nothing has no percentage. Nothing to nothing is no change.
  return current > 0 ? null : 0;
}

/**
 * How each model's spend or traffic moved between two windows, biggest move
 * first.
 */
export function modelChangeRows(
  current: SeriesPoint[],
  previous: SeriesPoint[],
  metric: ModelChangeMetric,
): ModelChangeRow[] {
  const currentByModel = new Map(current.map((point) => [modelKey(point), point]));
  const previousByModel = new Map(previous.map((point) => [modelKey(point), point]));

  // Models from either window, so that a retired one still explains a decrease.
  const models = new Map([...previousByModel, ...currentByModel]);

  const rows = [...models].map(([id, point]) => {
    const currentValue = currentByModel.get(id)?.[metric] ?? 0;
    const previousValue = previousByModel.get(id)?.[metric] ?? 0;
    const change = currentValue - previousValue;

    return {
      id: id,
      model: point.model ?? 'Unknown model',
      provider: point.provider ?? 'Unknown provider',
      current: currentValue,
      previous: previousValue,
      change: change,
      percentage: percentageOf(change, previousValue, currentValue),
    };
  });

  return rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.id.localeCompare(b.id));
}

/**
 * One row per model with its cost, efficiency, latency and failure rate.
 *
 * @param totals
 * Every request, grouped by provider and model.
 *
 * @param failures
 * The failed requests alone, grouped the same way.
 */
export function modelComparisonRows(totals: SeriesPoint[], failures: SeriesPoint[]): ModelComparisonRow[] {
  const failed = new Map(failures.map((point) => [modelKey(point), point.requests]));

  return totals.map((point) => {
    const tokens = point.input_tokens + point.output_tokens;

    // Gateway cache hits carry no tokens, so they are left out of the divisor.
    const answered = point.requests - point.gateway_cache_hits;
    const failedRequests = failed.get(modelKey(point)) ?? 0;

    return {
      id: modelKey(point),
      model: point.model ?? 'Unknown model',
      provider: point.provider ?? 'Unknown provider',
      requests: point.requests,
      spend: point.cost_total,
      costPerMillion: point.total_tokens > 0 ? (point.cost_total / point.total_tokens) * 1_000_000 : null,
      tokensPerRequest: answered > 0 ? point.total_tokens / answered : null,
      inputTokens: point.input_tokens,
      outputTokens: point.output_tokens,
      inputShare: tokens > 0 ? (point.input_tokens / tokens) * 100 : null,
      averageCost: point.requests > 0 ? point.cost_total / point.requests : null,
      latency: point.median_latency_ms,
      errorRate: point.requests > 0 ? (failedRequests / point.requests) * 100 : null,
    };
  });
}

/**
 * The rows in a new order, leaving the ones handed in as they were.
 */
export function sortModelRows(rows: ModelComparisonRow[], key: ModelSortKey, ascending: boolean): ModelComparisonRow[] {
  const direction = ascending ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];

    // Missing measurements stay last in either direction.
    if (left === null && right !== null) {
      return 1;
    }

    if (right === null && left !== null) {
      return -1;
    }

    const bothText = typeof left === 'string' && typeof right === 'string';
    const order = bothText ? left.localeCompare(right) : Number(left ?? 0) - Number(right ?? 0);

    // Ties break on the model, so equal rows keep a stable order.
    return order * direction || a.id.localeCompare(b.id);
  });
}
