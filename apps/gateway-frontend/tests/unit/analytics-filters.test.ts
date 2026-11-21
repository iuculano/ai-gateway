import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { windowBefore, windowOf } from '../../src/lib/components/analytics/analytics-filters.svelte';

afterEach(() => {
  setSystemTime();
});

test('a window ends on the last half minute, and the one before it on a five-minute mark', () => {
  setSystemTime(new Date('2026-09-10T12:03:47.000Z'));

  expect(windowOf(7)).toEqual({ start_date: '2026-09-03T12:03:30.000Z', end_date: '2026-09-10T12:03:30.000Z' });
  expect(windowBefore(7)).toEqual({ start_date: '2026-08-27T12:00:00.000Z', end_date: '2026-09-03T12:00:00.000Z' });
});
