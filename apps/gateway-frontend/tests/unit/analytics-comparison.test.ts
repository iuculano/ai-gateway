import { expect, test } from 'bun:test';
import { periodComparison } from '../../src/lib/data/analytics-comparison';

const WARNING = '#fbbf24';
const GOOD = '#34d399';
const INFORMATIVE = '#60a5fa';
const NEUTRAL = '#a1a1aa';

// Spend and error rate are better when lower. Request volume is neither good
// nor bad.
const COST = { label: 'the previous 7 days', lowerIsBetter: true };
const VOLUME = { label: 'the previous 7 days' };
const ERROR_RATE = { ...COST, percentagePoints: true };

test('where lower is better, a rise warns and a fall is good', () => {
  expect(periodComparison(132, 100, COST)).toMatchObject({ text: '↑ 32%', color: WARNING });
  expect(periodComparison(91, 100, COST)).toMatchObject({ text: '↓ 9%', color: GOOD });
});

test('where neither direction is better, a rise informs and a fall warns', () => {
  expect(periodComparison(118, 100, VOLUME)).toMatchObject({ text: '↑ 18%', color: INFORMATIVE });
  expect(periodComparison(82, 100, VOLUME)).toMatchObject({ text: '↓ 18%', color: WARNING });
});

test('rates compare in percentage points, including against a zero baseline', () => {
  expect(periodComparison(1.1, 1.5, ERROR_RATE).text).toBe('↓ 0.4 pp');
  expect(periodComparison(0.25, 0, ERROR_RATE).text).toBe('↑ 0.25 pp');
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
