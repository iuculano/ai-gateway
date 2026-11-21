import { expect, test } from 'bun:test';
import { percentileAt, percentileRank } from '../../src/lib/data/percentiles';

// Ninety-nine values, where the value at each percentile is its own number.
const PERCENTILES = Array.from({ length: 99 }, (_, index) => index + 1);

test('the median is the fiftieth of the ninety-nine values', () => {
  expect(percentileAt(PERCENTILES, 50)).toBe(50);
  expect(percentileAt(PERCENTILES, 99)).toBe(99);
});

test('a percentile that was not sent reads as zero', () => {
  expect(percentileAt([], 50)).toBe(0);
});

test('a value ranks by how many percentiles sit below it', () => {
  // Equal to the median is not above it.
  expect(percentileRank(PERCENTILES, 50)).toBe(49);
  expect(percentileRank(PERCENTILES, 0)).toBe(0);
  expect(percentileRank(PERCENTILES, 1000)).toBe(99);
});
