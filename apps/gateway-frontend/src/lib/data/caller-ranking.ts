import type { SeriesPoint } from '$lib/api/analytics';

export type CallerMetric = 'requests' | 'cost_total';

export function rankCallers(points: SeriesPoint[], metric: CallerMetric) {
  const total = points.reduce((sum, point) => sum + point[metric], 0);
  const ranked = [...points].sort((a, b) => b[metric] - a[metric]
    || JSON.stringify([a.actor_type, a.actor_id]).localeCompare(JSON.stringify([b.actor_type, b.actor_id])));
  const maximum = ranked[0]?.[metric] ?? 0;
  return ranked.slice(0, 6).map((point) => ({
    ...point,
    value: point[metric],
    share: total > 0 ? point[metric] / total * 100 : null,
    width: maximum > 0 ? point[metric] / maximum * 100 : 0,
  }));
}
