import type { SeriesPoint } from '$lib/api/analytics';

export function cumulativeSpend(points: SeriesPoint[]) {
  let input = 0;
  let output = 0;
  let total = 0;
  return [...points].sort((a, b) => (a.bucket ?? '').localeCompare(b.bucket ?? '')).map(point => ({
    ...point,
    cost_input: input += point.cost_input,
    cost_output: output += point.cost_output,
    cost_total: total += point.cost_total,
  }));
}

export const outcomes = [
  { id: 'complete', label: 'Success', color: '#10b981' },
  { id: 'incomplete', label: 'Incomplete', color: '#f59e0b' },
  { id: 'failed', label: 'Failed', color: '#ef4444' },
] as const;

export function outcomeBuckets(timeline: SeriesPoint[], points: SeriesPoint[]) {
  const counts = new Map<string, number>();
  for (const point of points) {
    const key = JSON.stringify([point.bucket, point.status]);
    counts.set(key, (counts.get(key) ?? 0) + point.requests);
  }
  return timeline.map(point => outcomes.map(outcome => counts.get(JSON.stringify([point.bucket, outcome.id])) ?? 0));
}
