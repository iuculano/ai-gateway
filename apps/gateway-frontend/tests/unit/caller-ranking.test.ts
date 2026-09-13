import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { rankCallers } from '../../src/lib/data/caller-ranking';

test('spend ranking includes callers outside the top six by requests and shares include all callers', () => {
  const points = Array.from(
    { length: 7 },
    (_, index) =>
      ({
        actor_type: 'api_key',
        actor_id: String(index),
        requests: 7 - index,
        cost_total: index === 6 ? 94 : 1,
      }) as SeriesPoint,
  );
  const byRequests = rankCallers(points, 'requests');
  expect(byRequests).toHaveLength(6);
  expect(byRequests[0]).toMatchObject({ actor_id: '0', share: 25, width: 100 });
  const bySpend = rankCallers(points, 'cost_total');
  expect(bySpend).toHaveLength(6);
  expect(bySpend[0]).toMatchObject({ actor_id: '6', value: 94, share: 94, width: 100 });
  expect(points.map((point) => point.actor_id)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
});

test('empty and zero-spend windows avoid invalid shares and bar widths', () => {
  expect(rankCallers([], 'requests')).toEqual([]);
  expect(
    rankCallers([{ actor_id: 'free', requests: 10, cost_total: 0 } as SeriesPoint], 'cost_total')[0],
  ).toMatchObject({ value: 0, share: null, width: 0 });
});
