import type { SeriesPoint } from '$lib/api/analytics';

export function modelComparisonRows(totals: SeriesPoint[], failures: SeriesPoint[]) {
  const key = (point: SeriesPoint) => JSON.stringify([point.provider, point.model]);
  const failed = new Map(failures.map((point) => [key(point), point.requests]));
  return totals.map((point) => ({
    id: key(point),
    model: point.model ?? 'Unknown model',
    provider: point.provider ?? 'Unknown provider',
    requests: point.requests,
    spend: point.cost_total,
    costPerMillion: point.total_tokens > 0 ? (point.cost_total / point.total_tokens) * 1_000_000 : null,
    tokensPerRequest: point.requests > 0 ? point.total_tokens / point.requests : null,
    inputTokens: point.input_tokens,
    outputTokens: point.output_tokens,
    inputShare:
      point.input_tokens + point.output_tokens > 0
        ? (point.input_tokens / (point.input_tokens + point.output_tokens)) * 100
        : null,
    averageCost: point.requests > 0 ? point.cost_total / point.requests : null,
    latency: point.average_latency_ms,
    errorRate: point.requests > 0 ? ((failed.get(key(point)) ?? 0) / point.requests) * 100 : null,
  }));
}

export type ModelComparisonRow = ReturnType<typeof modelComparisonRows>[number];
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

export function sortModelRows(rows: ModelComparisonRow[], key: ModelSortKey, ascending: boolean) {
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    // Missing measurements stay last in either direction.
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const order =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : Number(left ?? 0) - Number(right ?? 0);
    return order * (ascending ? 1 : -1) || a.id.localeCompare(b.id);
  });
}
