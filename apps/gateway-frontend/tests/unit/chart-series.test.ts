import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { cumulativeSpend, outcomeBuckets } from '../../src/lib/data/chart-series';

test('cumulative spend sorts buckets, preserves input and output totals, and leaves original data unchanged', () => {
  const points = [
    { bucket: '2026-09-02', cost_input: 3, cost_output: 4, cost_total: 7 },
    { bucket: '2026-09-01', cost_input: 1, cost_output: 2, cost_total: 3 },
    { bucket: '2026-09-03', cost_input: 0, cost_output: 0, cost_total: 0 },
  ] as SeriesPoint[];
  expect(cumulativeSpend(points).map((p) => [p.cost_input, p.cost_output, p.cost_total])).toEqual([
    [1, 2, 3],
    [4, 6, 10],
    [4, 6, 10],
  ]);
  expect(points[0]?.cost_total).toBe(7);
  expect(cumulativeSpend([])).toEqual([]);
});

test('outcomes align by bucket and status, summing duplicates and filling missing statuses with zero', () => {
  const timeline = [{ bucket: 'a' }, { bucket: 'b' }, { bucket: 'c' }] as SeriesPoint[];
  const points = [
    { bucket: 'b', status: 'failed', requests: 2 },
    { bucket: 'a', status: 'complete', requests: 10 },
    { bucket: 'a', status: 'incomplete', requests: 3 },
    { bucket: 'b', status: 'failed', requests: 4 },
  ] as SeriesPoint[];
  expect(outcomeBuckets(timeline, points)).toEqual([
    [10, 3, 0],
    [0, 0, 6],
    [0, 0, 0],
  ]);
});
