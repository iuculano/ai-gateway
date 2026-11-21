import { expect, test } from 'bun:test';
import type { SessionDistributionResponse } from '../../src/lib/api/analytics';
import {
  binPositions,
  costBand,
  costGrowth,
  heavySessions,
  type Position,
  participants,
  requestBand,
  type Session,
  sessionSpread,
} from '../../src/lib/data/sessions';

function position(index: number, requests: number, cost_total: number, input_tokens = 0): Position {
  return {
    position: index,
    requests: requests,
    sessions: requests,
    cost_total: cost_total,
    input_tokens: input_tokens,
  } as Position;
}

// binPositions

test('a bar is the average of the requests it covers, not the average of its positions', () => {
  // Position 1 was reached by nine requests at $1 each, position 2 by one
  // request at $11. Ten requests cost $20 between them.
  const rows = [position(1, 9, 9, 900), position(2, 1, 11, 1_100)];

  const bars = binPositions(rows, 1);

  expect(bars).toEqual([{ first: 1, last: 2, cost: 2, input: 200, sessions: 9 }]);
});

test('positions are only grouped once there are more of them than bars', () => {
  const rows = [position(1, 4, 4), position(2, 3, 6), position(3, 2, 6), position(4, 1, 4), position(5, 1, 5)];

  expect(binPositions(rows, 5).map((bar) => [bar.first, bar.last, bar.cost])).toEqual([
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
    [4, 4, 4],
    [5, 5, 5],
  ]);

  // Five positions in two bars is three to a bar, with the remainder last.
  expect(binPositions(rows, 2).map((bar) => [bar.first, bar.last])).toEqual([
    [1, 3],
    [4, 5],
  ]);
});

// costGrowth

test('a later request is compared with the first by what each costs on average', () => {
  const rows = [position(1, 10, 1), position(2, 10, 2), position(20, 2, 0.9)];

  // 45 cents a request at the twentieth against 10 cents at the first.
  expect(costGrowth(rows, 20)).toBeCloseTo(4.5);
});

test('there is no growth to report when no session got that far, or the first request was free', () => {
  expect(costGrowth([position(1, 10, 1)], 20)).toBeNull();
  expect(costGrowth([position(1, 10, 0), position(20, 2, 1)], 20)).toBeNull();
  expect(costGrowth([], 20)).toBeNull();
});

// Everyone's sessions

test('the typical session is the fiftieth percentile and the heavy one the ninety-fifth', () => {
  // p1 to p99, where each percentile's value is its own number.
  const percentiles = Array.from({ length: 99 }, (_, index) => index + 1);
  const distribution = {
    sessions: 400,
    cost_percentiles: percentiles,
    request_percentiles: percentiles.map((value) => value + 0.4),
    seconds_percentiles: percentiles,
  } as SessionDistributionResponse;

  expect(sessionSpread(distribution)).toEqual({ medianCost: 50, p95Cost: 95, medianRequests: 50, medianSeconds: 50 });
});

test('a window with no sessions has no typical session', () => {
  expect(sessionSpread({ sessions: 0 } as SessionDistributionResponse)).toBeNull();
  expect(sessionSpread(null)).toBeNull();
});

test('heavy sessions are the ones in bands of a dollar and up', () => {
  const bands = [
    { min: 0, max: 0.1, sessions: 80, cost_total: 3 },
    { min: 0.1, max: 1, sessions: 15, cost_total: 7 },
    { min: 1, max: 10, sessions: 4, cost_total: 20 },
    { min: 10, max: null, sessions: 1, cost_total: 70 },
  ] as SessionDistributionResponse['cost_bands'];

  expect(heavySessions(bands)).toEqual({ sessions: 5, spend: 90 });
});

// Labels

test('a spend band reads in cents under a dollar and is open at either end', () => {
  expect(costBand(0, 0.01)).toBe('< 1¢');
  expect(costBand(10, null)).toBe('$10+');

  expect(costBand(0.01, 0.1)).toBe('1¢ – 10¢');
  expect(costBand(0.1, 1)).toBe('10¢ – $1');
});

test('a request band of one count is that count, not a range', () => {
  expect(requestBand(1, 1)).toBe('1');
  expect(requestBand(2, 5)).toBe('2 – 5');
  expect(requestBand(21, null)).toBe('21+');
});

test('a session names its one user, or counts the users who shared it', () => {
  expect(participants({ user_id: 'grace', users: 1 } as Session)).toBe('grace');
  expect(participants({ user_id: '', users: 1_200 } as Session)).toBe('1.2K users');
  expect(participants({ user_id: '', users: 0 } as Session)).toBe('—');
});
