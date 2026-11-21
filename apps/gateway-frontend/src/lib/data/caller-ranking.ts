import type { SeriesPoint } from '#lib/api/analytics.ts';

export type CallerMetric = 'requests' | 'cost_total';

/**
 * A caller on a leaderboard, with the figure it is ranked by, the same figure
 * from the window before, and the length of its bar as a percentage of the
 * leader's.
 */
export type RankedCaller = SeriesPoint & { value: number; previous: number; width: number };

const LEADERBOARD_SIZE = 6;

function callerKey(point: SeriesPoint): string {
  return JSON.stringify([point.actor_type, point.actor_id]);
}

/**
 * The callers on either leaderboard, once each, which is everyone whose name
 * needs resolving.
 */
export function topCallerReferences(points: SeriesPoint[]): SeriesPoint[] {
  const leaders = [...rankCallers(points, 'requests'), ...rankCallers(points, 'cost_total')];
  const references = new Map(leaders.map((point) => [callerKey(point), point]));

  return [...references.values()];
}

/**
 * The leading callers by requests or by spend, each with a bar length relative
 * to the leader and its own figure from the window before.
 *
 * @param points
 * This window's rows, one per caller.
 *
 * @param metric
 * The figure to rank by.
 *
 * @param previousPoints
 * The window before, one row per caller.
 */
export function rankCallers(
  points: SeriesPoint[],
  metric: CallerMetric,
  previousPoints: SeriesPoint[] = [],
): RankedCaller[] {
  const previous = new Map(previousPoints.map((point) => [callerKey(point), point[metric]]));

  // Ties break on the caller, so the order does not shuffle between loads.
  const ranked = [...points].sort((a, b) => b[metric] - a[metric] || callerKey(a).localeCompare(callerKey(b)));
  const maximum = ranked[0]?.[metric] ?? 0;

  return ranked.slice(0, LEADERBOARD_SIZE).map((point) => ({
    ...point,
    value: point[metric],
    previous: previous.get(callerKey(point)) ?? 0,
    width: maximum > 0 ? (point[metric] / maximum) * 100 : 0,
  }));
}
