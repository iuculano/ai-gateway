import { afterEach, expect, test } from 'bun:test';
import { fmtBucket, fmtPricePerMillion } from '../../src/lib/data/format';

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

// fmtBucket

test('a day bucket is labelled with its own date, wherever the reader is', () => {
  // The backend buckets by UTC day. Seven hours behind it, midnight UTC is
  // still the evening before.
  process.env.TZ = 'America/Los_Angeles';

  expect(fmtBucket('2026-10-03T00:00:00.000Z', 'day')).toBe('Oct 3');
});

test('an hour bucket is labelled in the reader’s own time', () => {
  process.env.TZ = 'America/Los_Angeles';

  expect(fmtBucket('2026-10-03T21:00:00.000Z', 'hour')).toBe('14:00');
});

// fmtPricePerMillion

test('an unpublished price is not shown as free', () => {
  expect(fmtPricePerMillion(null)).toBe('Unpriced');
  expect(fmtPricePerMillion(0)).toBe('$0.00');
});

test('a price under a cent keeps the digit that makes it more than nothing', () => {
  expect(fmtPricePerMillion(0.005)).toBe('$0.005');
  expect(fmtPricePerMillion(1.25)).toBe('$1.25');
});
