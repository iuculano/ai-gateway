import type { SeriesPoint } from '#lib/api/analytics.ts';

type ModelSpend = Pick<SeriesPoint, 'provider' | 'model' | 'requests' | 'cost_total'>;
type Totals = { requests: number; cost: number };

/**
 * Spend before and after, and what it would have been after each step. The
 * steps are null when there was no traffic before to attribute a change to.
 */
export interface SpendAttribution {
  previousSpend: number;
  currentSpend: number;
  includesNewModels: boolean;
  steps: { afterVolume: number; afterMix: number } | null;
}

/**
 * One line of the explanation, with what a step added to spend or took away.
 */
export interface SpendEffect {
  label: string;
  amount: number | null;
  description: string;
}

/**
 * Requests and spend per provider and model, summing rows that repeat one.
 */
function totalsByModel(points: ModelSpend[]): Map<string, Totals> {
  const groups = new Map<string, Totals>();

  for (const point of points) {
    const key = JSON.stringify([point.provider, point.model]);
    const group = groups.get(key) ?? { requests: 0, cost: 0 };

    group.requests += point.requests;
    group.cost += point.cost_total;
    groups.set(key, group);
  }

  return groups;
}

function sumOf(groups: Map<string, Totals>): Totals {
  const total = { requests: 0, cost: 0 };

  for (const group of groups.values()) {
    total.requests += group.requests;
    total.cost += group.cost;
  }

  return total;
}

/**
 * Splits a change in spend into what volume, model mix and unit cost each
 * contributed, applied in that order.
 */
export function spendDrivers(current: ModelSpend[], previous: ModelSpend[]): SpendAttribution {
  const before = totalsByModel(previous);
  const after = totalsByModel(current);
  const previousTotal = sumOf(before);
  const currentTotal = sumOf(after);
  const previousSpend = previousTotal.cost;
  const currentSpend = currentTotal.cost;

  if (previousTotal.requests === 0) {
    return { previousSpend, currentSpend, steps: null, includesNewModels: currentTotal.requests > 0 };
  }

  // These are accounting contributions, not evidence that a price changed.
  const afterVolume = currentTotal.requests * (previousSpend / previousTotal.requests);
  let afterMix = 0;
  let includesNewModels = false;

  for (const [id, point] of after) {
    if (point.requests === 0) {
      continue;
    }

    const prior = before.get(id);
    const hasBaseline = prior !== undefined && prior.requests > 0;

    if (!hasBaseline) {
      includesNewModels = true;
    }

    // A model with no traffic before is priced at what it costs now, which
    // puts its whole effect on mix instead of inventing a price change for it.
    const referenceCost = hasBaseline ? prior.cost / prior.requests : point.cost / point.requests;

    afterMix += point.requests * referenceCost;
  }

  return { previousSpend, currentSpend, includesNewModels, steps: { afterVolume, afterMix } };
}

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * The three contributions as the explanation lists them, with the number of
 * decimal places they are shown to.
 */
export function spendEffects(attribution: SpendAttribution): { decimals: 2 | 6; effects: SpendEffect[] } {
  // A workload under a cent keeps its sub-cent precision, because at two
  // places every line of it would read as zero.
  const decimals: 2 | 6 = Math.max(attribution.previousSpend, attribution.currentSpend) < 0.01 ? 6 : 2;
  const amounts: (number | null)[] = [null, null, null];

  // The running totals are rounded before the differences are taken, so that
  // the contributions shown add up to the totals shown.
  if (attribution.steps) {
    const before = roundTo(attribution.previousSpend, decimals);
    const afterVolume = roundTo(attribution.steps.afterVolume, decimals);
    const afterMix = roundTo(attribution.steps.afterMix, decimals);
    const after = roundTo(attribution.currentSpend, decimals);

    amounts[0] = afterVolume - before;
    amounts[1] = afterMix - afterVolume;
    amounts[2] = after - afterMix;
  }

  const effects = [
    {
      label: 'Request volume',
      amount: amounts[0] ?? null,
      description: 'Change request count while keeping the previous model mix and average costs per request.',
    },
    {
      label: 'Model mix',
      amount: amounts[1] ?? null,
      description:
        'Change the mix of models at the current request count, using previous costs per request. New models use their current cost per request.',
    },
    {
      label: 'Cost per request',
      amount: amounts[2] ?? null,
      description:
        'Change average cost per request within models present in both periods. This can reflect token usage, caching or pricing.',
    },
  ];

  return { decimals: decimals, effects: effects };
}
