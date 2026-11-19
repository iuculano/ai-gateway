import { expect, test } from 'bun:test';
import { spendForecast } from '../../src/lib/data/spend-forecast';

const day = (date: string, cost_total: number) => ({ bucket: `${date}T00:00:00.000Z`, cost_total });

test('projects the rest of the month at the last 7 days of spend', () => {
  const points = [day('2026-09-30', 50), day('2026-10-01', 4)];
  for (let date = 2; date <= 10; date++) points.push(day(`2026-10-${String(date).padStart(2, '0')}`, 10));

  // Noon on the 10th: 9 full days of 10 before it, then 21.5 days to go at 10/day.
  const forecast = spendForecast(points, new Date('2026-10-10T12:00:00Z'));

  expect(forecast.monthToDate).toBe(4 + 9 * 10);
  expect(forecast.lastMonth).toBe(50);
  expect(forecast.runRate).toBe(10);
  expect(forecast.projected).toBe(94 + 21.5 * 10);
  expect(forecast.days).toHaveLength(31);
  expect(forecast.days[9]).toMatchObject({ actual: 10, projected: null });
  expect(forecast.days[10]).toMatchObject({ actual: null, projected: 10 });
});

test('running totals, the projected path, and last month at the same point', () => {
  // September: 30 days of 3. October so far: 10 a day through the 10th.
  const points = [];
  for (let date = 1; date <= 30; date++) points.push(day(`2026-09-${String(date).padStart(2, '0')}`, 3));
  for (let date = 1; date <= 10; date++) points.push(day(`2026-10-${String(date).padStart(2, '0')}`, 10));

  const forecast = spendForecast(points, new Date('2026-10-10T12:00:00Z'));

  // Nine full September days plus half of the 10th.
  expect(forecast.lastMonthToDate).toBe(9 * 3 + 1.5);
  expect(forecast.days[0]).toMatchObject({ cumulative: 10, projectedCumulative: null, lastMonthCumulative: 3 });
  // Today: the projected path starts from the total so far.
  expect(forecast.days[9]).toMatchObject({ cumulative: 100, projectedCumulative: 100 });
  // The 11th ends 1.5 days from now at 10 a day.
  expect(forecast.days[10]).toMatchObject({ cumulative: null, projectedCumulative: 115 });
  // The path ends on the projection; September had no 31st.
  expect(forecast.days[30]?.projectedCumulative).toBe(forecast.projected);
  expect(forecast.days[30]?.lastMonthCumulative).toBeNull();
  expect(forecast.days[29]?.lastMonthCumulative).toBe(90);
});

test('a younger history averages over the days it has', () => {
  const forecast = spendForecast([day('2026-10-08', 6), day('2026-10-09', 2)], new Date('2026-10-10T00:00:00Z'));

  expect(forecast.runRate).toBe(4);
});

test('with no full day of history there is nothing to project', () => {
  const forecast = spendForecast([day('2026-10-10', 5)], new Date('2026-10-10T08:00:00Z'));

  expect(forecast.monthToDate).toBe(5);
  expect(forecast.runRate).toBeNull();
  expect(forecast.projected).toBeNull();
});
