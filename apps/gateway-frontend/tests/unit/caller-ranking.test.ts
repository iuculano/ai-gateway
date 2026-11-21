import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { rankCallers, topCallerReferences } from '../../src/lib/data/caller-ranking';

function caller(id: string, requests: number, cost_total: number): SeriesPoint {
  return {
    actor_type: 'api_key',
    actor_id: id,
    requests: requests,
    cost_total: cost_total,
  } as SeriesPoint;
}

// rankCallers

test('a leaderboard holds the top six, with bars scaled to the leader', () => {
  // Seven callers by descending requests. The last one spends nearly
  // everything.
  const points = [
    caller('0', 7, 1),
    caller('1', 6, 1),
    caller('2', 5, 1),
    caller('3', 4, 1),
    caller('4', 3, 1),
    caller('5', 2, 1),
    caller('6', 1, 94),
  ];

  const byRequests = rankCallers(points, 'requests');
  const bySpend = rankCallers(points, 'cost_total');

  expect(byRequests).toHaveLength(6);
  expect(byRequests[0]).toMatchObject({ actor_id: '0', value: 7, width: 100 });
  expect(byRequests[5]?.width).toBeCloseTo((2 / 7) * 100);

  // Ranked by spend, the caller with the fewest requests leads.
  expect(bySpend).toHaveLength(6);
  expect(bySpend[0]).toMatchObject({ actor_id: '6', value: 94, width: 100 });
});

test('ranking leaves the input order alone', () => {
  const points = [caller('low', 1, 1), caller('high', 9, 9)];

  rankCallers(points, 'requests');

  expect(points.map((point) => point.actor_id)).toEqual(['low', 'high']);
});

test('a window with no spend has empty bars', () => {
  const [free] = rankCallers([caller('free', 10, 0)], 'cost_total');

  expect(free).toMatchObject({ value: 0, width: 0 });
});

test('a caller is compared with its own figure from the window before, and a new caller with zero', () => {
  const user = { ...caller('a', 4, 4), actor_type: 'user' } as SeriesPoint;
  const previous = [caller('a', 3, 9), caller('gone', 50, 50)];

  // The user shares an id with the key and is still a different caller.
  const ranked = rankCallers([caller('a', 10, 1), user], 'requests', previous);

  expect(ranked.map((row) => [row.actor_type, row.value, row.previous])).toEqual([
    ['api_key', 10, 3],
    ['user', 4, 0],
  ]);
});

// topCallerReferences

test('names are resolved for both leaderboards only, without repeating a caller on both', () => {
  // 500 callers where the busiest spend the least, so the two leaderboards do
  // not overlap.
  const points: SeriesPoint[] = [];

  for (let index = 0; index < 500; index++) {
    points.push(caller(String(index), 500 - index, index));
  }

  const references = topCallerReferences(points);
  const ids = references.map((point) => point.actor_id);

  expect(ids.sort()).toEqual(['0', '1', '2', '3', '4', '494', '495', '496', '497', '498', '499', '5']);
});

test('a caller on both leaderboards is resolved once', () => {
  const points = [caller('a', 3, 3), caller('b', 2, 2), caller('c', 1, 1)];

  expect(topCallerReferences(points)).toHaveLength(3);
});
