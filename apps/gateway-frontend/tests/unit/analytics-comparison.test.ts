import { expect, test } from 'bun:test';
import { periodComparison } from '../../src/lib/data/analytics-comparison';

const options = { label: 'the previous 7 days', lowerIsBetter: true };

test('relative changes distinguish improvements from increases', () => {
  expect(periodComparison(132, 100, options)).toMatchObject({ text: '↑ 32%', color: '#fbbf24' });
  expect(periodComparison(91, 100, options)).toMatchObject({ text: '↓ 9%', color: '#34d399' });
  expect(periodComparison(118, 100, { label: options.label })).toMatchObject({ text: '↑ 18%', color: '#60a5fa' });
  expect(periodComparison(82, 100, { label: options.label })).toMatchObject({ text: '↓ 18%', color: '#fbbf24' });
});

test('relative error-rate changes use percentages of the previous rate', () => {
  expect(periodComparison(1.38, 1, options)).toMatchObject({ text: '↑ 38%', color: '#fbbf24' });
  expect(periodComparison(0.5, 1, options)).toMatchObject({ text: '↓ 50%', color: '#34d399' });
});

test('error rates use percentage points, including a zero baseline', () => {
  expect(periodComparison(1.1, 1.5, { ...options, percentagePoints: true }).text).toBe('↓ 0.4 pp');
  expect(periodComparison(0.25, 0, { ...options, percentagePoints: true }).text).toBe('↑ 0.25 pp');
});

test('zero, absent, and non-finite baselines never produce misleading percentages', () => {
  expect(periodComparison(10, 0, options)).toMatchObject({ text: 'New', color: '#fbbf24' });
  expect(periodComparison(10, 0, { label: options.label })).toMatchObject({ text: 'New', color: '#60a5fa' });
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
