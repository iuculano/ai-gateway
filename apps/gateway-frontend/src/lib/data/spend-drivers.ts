import type { SeriesPoint } from '$lib/api/analytics';

type ModelSpend = Pick<SeriesPoint, 'provider' | 'model' | 'requests' | 'cost_total'>;

/**
 * Sequential attribution: change total traffic, then model mix, then unit costs.
 * New models use their current unit cost as the reference, assigning their
 * effect to mix rather than inventing a historical price change.
 * These are accounting contributions, not evidence of causal price changes.
 */
export function spendDrivers(current: ModelSpend[], previous: ModelSpend[]) {
  const key = (point: ModelSpend) => JSON.stringify([point.provider, point.model]);
  const aggregate = (points: ModelSpend[]) => {
    const groups = new Map<string, { requests: number; cost: number }>();
    for (const point of points) {
      const group = groups.get(key(point)) ?? { requests: 0, cost: 0 };
      group.requests += point.requests;
      group.cost += point.cost_total;
      groups.set(key(point), group);
    }
    return groups;
  };
  const before = aggregate(previous);
  const after = aggregate(current);
  const previousRequests = [...before.values()].reduce((sum, point) => sum + point.requests, 0);
  const currentRequests = [...after.values()].reduce((sum, point) => sum + point.requests, 0);
  const previousSpend = [...before.values()].reduce((sum, point) => sum + point.cost, 0);
  const currentSpend = [...after.values()].reduce((sum, point) => sum + point.cost, 0);
  if (previousRequests === 0) {
    return { previousSpend, currentSpend, steps: null, includesNewModels: currentRequests > 0 };
  }

  const afterVolume = currentRequests * (previousSpend / previousRequests);
  let afterMix = 0;
  let includesNewModels = false;
  for (const [id, point] of after) {
    if (point.requests === 0) continue;
    const prior = before.get(id);
    const hasBaseline = prior !== undefined && prior.requests > 0;
    if (!hasBaseline) includesNewModels = true;
    const referenceCost = hasBaseline ? prior.cost / prior.requests : point.cost / point.requests;
    afterMix += point.requests * referenceCost;
  }
  return {
    previousSpend,
    currentSpend,
    includesNewModels,
    steps: { afterVolume, afterMix },
  };
}
