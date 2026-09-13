import { expect, test } from 'bun:test';
import { periodComparison } from '../../src/lib/data/analytics-comparison';

const options = { label: 'the previous 7 days', lowerIsBetter: true };

test('relative changes distinguish improvements from increases', () => {
  expect(periodComparison(132, 100, options)).toMatchObject({ text: '↑ 32%', color: '#fbbf24' });
  expect(periodComparison(91, 100, options)).toMatchObject({ text: '↓ 9%', color: '#34d399' });
  expect(periodComparison(118, 100, { label: options.label })).toMatchObject({ text: '↑ 18%', color: '#a1a1aa' });
});

test('error rates use percentage points, including a zero baseline', () => {
  expect(periodComparison(1.1, 1.5, { ...options, percentagePoints: true }).text).toBe('↓ 0.4 pp');
  expect(periodComparison(0.25, 0, { ...options, percentagePoints: true }).text).toBe('↑ 0.25 pp');
});

test('zero, absent, and non-finite baselines never produce misleading percentages', () => {
  expect(periodComparison(10, 0, options).text).toBe('New');
  expect(periodComparison(0, 0, options).text).toBe('0%');
  expect(periodComparison(0, 10, options).text).toBe('↓ 100%');
  expect(periodComparison(10, null, options).text).toBe('No prior data');
  expect(periodComparison(null, 10, options).text).toBe('No prior data');
  expect(periodComparison(Infinity, 10, options).text).toBe('No prior data');
});

test('rounded zero changes are neutral and explain the comparison period', () => {
  const result = periodComparison(100.001, 100, options);
  expect(result.text).toBe('0%');
  expect(result.color).toBe('#a1a1aa');
  expect(result.title).toContain('previous 7 days');
});
