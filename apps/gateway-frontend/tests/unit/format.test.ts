import { expect, test } from 'bun:test';
import {
  fmt,
  fmtBucket,
  fmtClock,
  fmtDollars,
  fmtElapsed,
  fmtMoney,
  fmtPricePerMillion,
  fmtTs,
  initialsOf,
  parseUA,
} from '../../src/lib/data/format';

// Real user agent strings, because the patterns only make sense against them.
const USER_AGENTS = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    label: 'Chrome 131 · macOS',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    label: 'Safari 17 · macOS',
  },
  {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    label: 'Safari 17 · iOS',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    label: 'Firefox 133 · Windows',
  },
];

// fmt

test('a count just under a million reads as a million, not as a thousand thousands', () => {
  expect(fmt(999_999)).toBe('1M');
  expect(fmt(1_234)).toBe('1.23K');
  expect(fmt(950)).toBe('950');
});

// Dates

test('a day bucket is labelled with its own date, wherever the reader is', () => {
  // The backend buckets by UTC day.
  expect(fmtBucket('2026-10-03T00:00:00.000Z', 'day')).toBe('Oct 3');
});

test('an hour bucket is labelled in the reader’s own time', () => {
  expect(fmtBucket('2026-10-03T21:00:00.000Z', 'hour')).toBe('14:00');
});

test('the short form of a timestamp is the same UTC day as its full form', () => {
  const stamp = fmtTs('2026-06-17T02:44:02.000Z');

  expect(stamp).toEqual({ short: 'Jun 17', time: '02:44:02', full: '2026-06-17 02:44:02 UTC' });
});

test('a time of day is on the reader’s 24-hour clock, with midnight as 00', () => {
  expect(fmtClock('2026-06-17T07:00:05.000Z')).toBe('00:00:05');
  expect(fmtClock('2026-06-17T23:44:02.000Z')).toBe('16:44:02');
});

test('a length of time keeps its two coarsest units', () => {
  expect(fmtElapsed(45.2)).toBe('45s');
  expect(fmtElapsed(252)).toBe('4m 12s');
  expect(fmtElapsed(7_530)).toBe('2h 5m');
});

// Money

test('money is to the cent, except under a cent, where it keeps the digits that make it more than nothing', () => {
  expect(fmtMoney(1_234.5)).toBe('$1,234.50');
  expect(fmtMoney(0)).toBe('$0.00');

  expect(fmtMoney(0.0042)).toBe('$0.0042');
  expect(fmtMoney(-0.0042)).toBe('-$0.0042');
});

test('money can carry more decimals than two, and never loses them under a cent', () => {
  expect(fmtMoney(0.1239, 4)).toBe('$0.1239');
  expect(fmtMoney(0.000001234, 12)).toBe('$0.000001234');
});

test('dollars at a fixed precision round an amount under a cent away', () => {
  // The spend explanation rounds every figure the same way so that its steps
  // add up to its totals.
  expect(fmtDollars(0.0042, 2)).toBe('$0.00');
  expect(fmtDollars(0.0042, 6)).toBe('$0.0042');
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

// initialsOf

test('initials keep letters that are not plain ASCII', () => {
  expect(initialsOf('Élodie Durand')).toBe('ÉD');
  expect(initialsOf('张伟')).toBe('张');
  expect(initialsOf('ada lovelace')).toBe('AL');
});

// parseUA

test('a user agent is read as its browser and system', () => {
  for (const { ua, label } of USER_AGENTS) {
    expect(parseUA(ua)).toBe(label);
  }
});

test('a request with no user agent came from the system', () => {
  expect(parseUA(null)).toBe('System');
});
