import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import {
  axisTop,
  brokenLinePath,
  cumulativeSpend,
  failureRates,
  outcomeBuckets,
  perRequestSpend,
  providerSplit,
  showsTick,
  stackedAreaPaths,
} from '../../src/lib/data/chart-series';

function identity(value: number): number {
  return value;
}

// perRequestSpend

test('a bucket with no requests has no average, where free requests average zero', () => {
  const points = [
    { bucket: '2026-09-01', requests: 4, cost_input: 2, cost_output: 6, cost_total: 8 },
    { bucket: '2026-09-02', requests: 3, cost_input: 0, cost_output: 0, cost_total: 0 },
    { bucket: '2026-09-03', requests: 0, cost_input: 0, cost_output: 0, cost_total: 0 },
  ] as SeriesPoint[];

  const averages = perRequestSpend(points);

  expect(averages.map((point) => [point.cost_input, point.cost_output, point.cost_total])).toEqual([
    [0.5, 1.5, 2],
    [0, 0, 0],
    [null, null, null],
  ]);
});

// cumulativeSpend

test('cumulative spend runs in bucket order, keeping input and output apart', () => {
  const points = [
    { bucket: '2026-09-02', cost_input: 3, cost_output: 4, cost_total: 7 },
    { bucket: '2026-09-01', cost_input: 1, cost_output: 2, cost_total: 3 },
    { bucket: '2026-09-03', cost_input: 0, cost_output: 0, cost_total: 0 },
  ] as SeriesPoint[];

  const running = cumulativeSpend(points);

  expect(running.map((point) => [point.cost_input, point.cost_output, point.cost_total])).toEqual([
    [1, 2, 3],
    [4, 6, 10],
    [4, 6, 10],
  ]);

  // The points handed in are neither reordered nor summed in place.
  expect(points[0]?.cost_total).toBe(7);
});

// outcomeBuckets

test('outcomes line up with the timeline, summing duplicates and filling gaps with zero', () => {
  const timeline = [{ bucket: 'a' }, { bucket: 'b' }, { bucket: 'c' }] as SeriesPoint[];
  const points = [
    { bucket: 'b', status: 'failed', requests: 2 },
    { bucket: 'a', status: 'complete', requests: 10 },
    { bucket: 'a', status: 'incomplete', requests: 3 },
    { bucket: 'b', status: 'failed', requests: 4 },
  ] as SeriesPoint[];

  const buckets = outcomeBuckets(timeline, points);

  // One row per bucket, as complete, incomplete, failed.
  expect(buckets).toEqual([
    [10, 3, 0],
    [0, 0, 6],
    [0, 0, 0],
  ]);
});

// failureRates

test('a bucket’s error rate is failures over every request, and an empty bucket has none', () => {
  const timeline = [
    { bucket: 'a', requests: 200 },
    { bucket: 'b', requests: 0 },
  ] as SeriesPoint[];

  // As complete, incomplete, failed. The 40 in flight stay in the total.
  const counts = [
    [150, 40, 10],
    [0, 0, 0],
  ];

  expect(failureRates(timeline, counts)).toEqual([5, null]);
});

// providerSplit

test('providers stack busiest first in every bucket, with zero where one was absent', () => {
  const points = [
    { bucket: '2026-09-02', provider: 'openai', requests: 5, cost_total: 1 },
    { bucket: '2026-09-01', provider: 'anthropic', requests: 2, cost_total: 30 },
    { bucket: '2026-09-01', provider: 'openai', requests: 8, cost_total: 2 },
  ] as SeriesPoint[];

  const split = providerSplit(points, 'cost_total');

  // Ordered by requests although spend is what is stacked, so the layers do
  // not swap when the chart changes figure.
  expect(split.providers).toEqual(['openai', 'anthropic']);
  expect(split.buckets).toEqual(['2026-09-01', '2026-09-02']);
  expect(split.values).toEqual([
    [2, 30],
    [1, 0],
  ]);
  expect(split.totals).toEqual([32, 1]);
});

// Axes

test('an axis tops out on the next half power of ten above its peak', () => {
  expect(axisTop(1_340)).toBe(1_500);
  expect(axisTop(87)).toBe(90);
  expect(axisTop(100)).toBe(100);

  // An empty chart still needs an axis to draw.
  expect(axisTop(0)).toBe(1);
});

test('the last label is always drawn, and a regular one that would crowd it is not', () => {
  const shown: number[] = [];

  for (let index = 0; index < 8; index += 1) {
    if (showsTick(index, 3, 8)) {
      shown.push(index);
    }
  }

  // Index 6 is a regular tick, one place from the end.
  expect(shown).toEqual([0, 3, 7]);
});

// Paths

test('each area sits on top of the ones before it', () => {
  const stacks = [
    [1, 10],
    [2, 20],
  ];

  const paths = stackedAreaPaths(stacks, identity, identity);

  expect(paths).toEqual(['M0,1 L1,2 L1,0 L0,0 Z', 'M0,11 L1,22 L1,2 L0,1 Z']);
});

test('a line breaks at a missing value and starts again after it', () => {
  expect(brokenLinePath([1, null, 3, 4], identity, identity)).toBe('M0,1 M2,3 L3,4');
});
