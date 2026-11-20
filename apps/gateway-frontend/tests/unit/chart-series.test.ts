import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { cumulativeSpend, outcomeBuckets } from '../../src/lib/data/chart-series';

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
