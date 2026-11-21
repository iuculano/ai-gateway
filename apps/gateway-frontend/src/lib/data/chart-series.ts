import type { SeriesPoint } from '#lib/api/analytics.ts';
import type { CallerMetric } from '#lib/data/caller-ranking.ts';

type Scale = (value: number) => number;

export const outcomes = [
  { id: 'complete', label: 'Success', color: '#10b981' },
  { id: 'incomplete', label: 'Incomplete', color: '#f59e0b' },
  { id: 'failed', label: 'Failed', color: '#ef4444' },
] as const;

/**
 * Where failed requests sit in a row of `outcomeBuckets`.
 */
export const FAILED = outcomes.findIndex((outcome) => outcome.id === 'failed');

/**
 * Spend as a running total, in bucket order.
 */
export function cumulativeSpend(points: SeriesPoint[]): SeriesPoint[] {
  const ordered = [...points].sort((a, b) => (a.bucket ?? '').localeCompare(b.bucket ?? ''));
  const running: SeriesPoint[] = [];
  let input = 0;
  let output = 0;
  let total = 0;

  for (const point of ordered) {
    input += point.cost_input;
    output += point.cost_output;
    total += point.cost_total;

    running.push({ ...point, cost_input: input, cost_output: output, cost_total: total });
  }

  return running;
}

/**
 * A bucket's spend, where an amount is null when there is nothing to show.
 */
export type SpendPoint = Omit<SeriesPoint, 'cost_input' | 'cost_output' | 'cost_total'> & {
  cost_input: number | null;
  cost_output: number | null;
  cost_total: number | null;
};

/**
 * Spend per request in each bucket, over every request in it.
 */
export function perRequestSpend(points: SeriesPoint[]): SpendPoint[] {
  const averages: SpendPoint[] = [];

  for (const point of points) {
    // A bucket with no requests has no average, which is not the same as
    // requests that were free.
    const hasRequests = point.requests > 0;

    averages.push({
      ...point,
      cost_input: hasRequests ? point.cost_input / point.requests : null,
      cost_output: hasRequests ? point.cost_output / point.requests : null,
      cost_total: hasRequests ? point.cost_total / point.requests : null,
    });
  }

  return averages;
}

/**
 * Requests per outcome for each bucket of the timeline, in the order of
 * `outcomes`.
 */
export function outcomeBuckets(timeline: SeriesPoint[], points: SeriesPoint[]): number[][] {
  const counts = new Map<string, number>();

  for (const point of points) {
    const key = JSON.stringify([point.bucket, point.status]);
    counts.set(key, (counts.get(key) ?? 0) + point.requests);
  }

  return timeline.map((point) =>
    outcomes.map((outcome) => counts.get(JSON.stringify([point.bucket, outcome.id])) ?? 0),
  );
}

/**
 * The percentage of each bucket's requests that failed, or null for a bucket
 * with no requests, which has no rate.
 *
 * @param timeline
 * One point per bucket, carrying every request in it.
 *
 * @param counts
 * The same buckets from `outcomeBuckets`.
 */
export function failureRates(timeline: SeriesPoint[], counts: number[][]): (number | null)[] {
  // Requests still in flight stay in the denominator, as they do in the
  // headline rate.
  return timeline.map((point, index) => {
    if (point.requests <= 0) {
      return null;
    }

    return ((counts[index]?.[FAILED] ?? 0) / point.requests) * 100;
  });
}

/**
 * Each provider's figure in each bucket, for a stacked chart.
 *
 * @param points
 * Rows grouped by bucket and provider.
 *
 * @param metric
 * The figure to stack.
 */
export function providerSplit(
  points: SeriesPoint[],
  metric: CallerMetric,
): { buckets: string[]; providers: string[]; values: number[][]; totals: number[] } {
  const buckets = new Set<string>();
  const requests = new Map<string, number>();
  const cells = new Map<string, number>();

  for (const point of points) {
    const bucket = point.bucket ?? '';
    const provider = point.provider ?? 'unknown';

    buckets.add(bucket);
    requests.set(provider, (requests.get(provider) ?? 0) + point.requests);
    cells.set(JSON.stringify([bucket, provider]), point[metric]);
  }

  // Busiest first by requests whichever figure is stacked, so the layers keep
  // their order when the chart switches between requests and spend.
  const providers = [...requests].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);
  const ordered = [...buckets].sort();
  const values = ordered.map((bucket) =>
    providers.map((provider) => cells.get(JSON.stringify([bucket, provider])) ?? 0),
  );

  return {
    buckets: ordered,
    providers: providers,
    values: values,
    totals: values.map((row) => row.reduce((sum, value) => sum + value, 0)),
  };
}

/**
 * The top of an axis for a peak value, rounded up so that gridlines land on
 * round numbers.
 */
export function axisTop(peak: number): number {
  if (peak <= 0) {
    return 1;
  }

  // Half a power of ten, so a peak of 1,340 tops out at 1,500 and not 2,000.
  const step = 10 ** Math.floor(Math.log10(peak)) / 2;

  return Math.ceil(peak / step) * step;
}

/**
 * Whether an axis label is drawn at an index, when every nth one is.
 */
export function showsTick(index: number, every: number, total: number): boolean {
  const last = total - 1;

  // The last label is always drawn, so a regular one that would sit under it
  // is left out.
  return index === last || (index % every === 0 && last - index >= every - 1);
}

/**
 * One closed SVG path per series, each stacked on the ones before it.
 *
 * @param stacks
 * One row per bucket, holding each series' value there.
 *
 * @param x
 * A bucket's index to its horizontal position.
 *
 * @param y
 * A stacked value to its vertical position.
 */
export function stackedAreaPaths(stacks: number[][], x: Scale, y: Scale): string[] {
  const seriesCount = stacks[0]?.length ?? 0;
  const paths: string[] = [];
  let floor = stacks.map(() => 0);

  for (let series = 0; series < seriesCount; series += 1) {
    const ceiling = stacks.map((row, bucket) => (floor[bucket] ?? 0) + (row[series] ?? 0));

    // Along the top from the left, then back along the bottom from the right.
    const top = ceiling.map((value, bucket) => `${bucket === 0 ? 'M' : 'L'}${x(bucket)},${y(value)}`);
    const bottom = floor.map((value, bucket) => `L${x(bucket)},${y(value)}`).reverse();

    paths.push([...top, ...bottom, 'Z'].join(' '));
    floor = ceiling;
  }

  return paths;
}

/**
 * An SVG line through the values, broken wherever one is missing.
 */
export function brokenLinePath(values: (number | null)[], x: Scale, y: Scale): string {
  const commands: string[] = [];
  let isConnected = false;

  for (const [index, value] of values.entries()) {
    if (value === null) {
      isConnected = false;
      continue;
    }

    commands.push(`${isConnected ? 'L' : 'M'}${x(index)},${y(value)}`);
    isConnected = true;
  }

  return commands.join(' ');
}
