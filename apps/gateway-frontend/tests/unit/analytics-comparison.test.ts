import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { headlineComparisons, headlineFigures, periodComparison } from '../../src/lib/data/analytics-comparison';

const WARNING = '#fbbf24';
const GOOD = '#34d399';
const INFORMATIVE = '#60a5fa';
const NEUTRAL = '#a1a1aa';

// Spend and error rate are better when lower. Request volume is neither good
// nor bad.
const COST = { label: 'the previous 7 days', lowerIsBetter: true };
const VOLUME = { label: 'the previous 7 days' };

test('where lower is better, a rise warns and a fall is good', () => {
  expect(periodComparison(132, 100, COST)).toMatchObject({ text: '↑ 32%', color: WARNING });
  expect(periodComparison(91, 100, COST)).toMatchObject({ text: '↓ 9%', color: GOOD });
});

test('where neither direction is better, a rise informs and a fall warns', () => {
  expect(periodComparison(118, 100, VOLUME)).toMatchObject({ text: '↑ 18%', color: INFORMATIVE });
  expect(periodComparison(82, 100, VOLUME)).toMatchObject({ text: '↓ 18%', color: WARNING });
});

test('a rise from zero is new, because a percentage of nothing is undefined', () => {
  expect(periodComparison(10, 0, COST)).toMatchObject({ text: 'New', color: WARNING });
  expect(periodComparison(10, 0, VOLUME)).toMatchObject({ text: 'New', color: INFORMATIVE });
});

test('a fall to zero is a full decrease, and zero against zero is no change', () => {
  expect(periodComparison(0, 10, COST).text).toBe('↓ 100%');
  expect(periodComparison(0, 0, COST).text).toBe('0%');
});

test('a missing or non-finite value on either side has nothing to compare', () => {
  expect(periodComparison(10, null, COST).text).toBe('No prior data');
  expect(periodComparison(null, 10, COST).text).toBe('No prior data');
  expect(periodComparison(Infinity, 10, COST).text).toBe('No prior data');
});

test('a change that rounds to zero is neutral and names the period it compares against', () => {
  const result = periodComparison(100.001, 100, COST);

  expect(result.text).toBe('0%');
  expect(result.color).toBe(NEUTRAL);
  expect(result.title).toContain('previous 7 days');
});

// Headline figures

test('the error rate counts failures only, with requests still in flight left in the total', () => {
  const totals = { requests: 200, total_tokens: 9_000, cost_total: 50, median_latency_ms: 300 } as SeriesPoint;
  const statuses = [
    { status: 'complete', requests: 150 },
    { status: 'incomplete', requests: 40 },
    { status: 'failed', requests: 10 },
  ] as SeriesPoint[];

  const headline = headlineFigures(totals, statuses);

  expect(headline).toEqual({
    requests: 200,
    tokens: 9_000,
    spend: 50,
    averageCost: 0.25,
    latency: 300,
    errorRate: 5,
    inFlightRate: 20,
  });
});

test('a window with no requests has no rates and no average, and they are not zero', () => {
  expect(headlineFigures(null, [])).toMatchObject({ requests: 0, averageCost: null, errorRate: null });
});

test('more spend, latency or errors warns, and more traffic only informs', () => {
  const before = headlineFigures(
    { requests: 100, total_tokens: 100, cost_total: 10, median_latency_ms: 100 } as SeriesPoint,
    [{ status: 'failed', requests: 1 }] as SeriesPoint[],
  );
  const after = headlineFigures(
    { requests: 200, total_tokens: 200, cost_total: 40, median_latency_ms: 150 } as SeriesPoint,
    [{ status: 'failed', requests: 6 }] as SeriesPoint[],
  );

  const moved = headlineComparisons(after, before, 'the previous 7 days');

  expect(moved.requests).toMatchObject({ text: '↑ 100%', color: INFORMATIVE });
  expect(moved.tokens).toMatchObject({ text: '↑ 100%', color: INFORMATIVE });
  expect(moved.spend).toMatchObject({ text: '↑ 300%', color: WARNING });
  expect(moved.averageCost).toMatchObject({ text: '↑ 100%', color: WARNING });
  expect(moved.latency).toMatchObject({ text: '↑ 50%', color: WARNING });
  expect(moved.errorRate).toMatchObject({ text: '↑ 200%', color: WARNING });
});

test('with no window before, no headline figure is compared', () => {
  const moved = headlineComparisons(headlineFigures(null, []), null, 'the previous 7 days');

  expect(Object.values(moved).map((comparison) => comparison.text)).toEqual(Array(6).fill('No prior data'));
});
