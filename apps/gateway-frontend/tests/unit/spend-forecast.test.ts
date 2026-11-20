import { expect, test } from 'bun:test';
import { spendForecast } from '../../src/lib/data/spend-forecast';

type DailySpend = { bucket: string; cost_total: number };

function day(date: string, cost_total: number): DailySpend {
  return { bucket: `${date}T00:00:00.000Z`, cost_total: cost_total };
}

function days(month: string, from: number, through: number, cost_total: number): DailySpend[] {
  const points: DailySpend[] = [];

  for (let date = from; date <= through; date++) {
    const padded = String(date).padStart(2, '0');
    points.push(day(`${month}-${padded}`, cost_total));
  }

  return points;
}

test('projects the rest of the month at the last 7 days of spend', () => {
  const points = [day('2026-09-30', 50), day('2026-10-01', 4), ...days('2026-10', 2, 10, 10)];

  // Noon on the 10th. Nine full days of 10 came before it, and 21.5 days remain
  // at 10 a day.
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
  // September had 30 days of 3. October has 10 a day through the 10th.
  const points = [...days('2026-09', 1, 30, 3), ...days('2026-10', 1, 10, 10)];

  const forecast = spendForecast(points, new Date('2026-10-10T12:00:00Z'));

  // Nine full September days plus half of the 10th.
  expect(forecast.lastMonthToDate).toBe(9 * 3 + 1.5);
  expect(forecast.days[0]).toMatchObject({ cumulative: 10, projectedCumulative: null, lastMonthCumulative: 3 });

  // Today is where the projected path starts, from the total so far.
  expect(forecast.days[9]).toMatchObject({ cumulative: 100, projectedCumulative: 100 });

  // The 11th ends 1.5 days from now at 10 a day.
  expect(forecast.days[10]).toMatchObject({ cumulative: null, projectedCumulative: 115 });

  // The path ends on the projection, and September had no 31st.
  expect(forecast.days[30]?.projectedCumulative).toBe(forecast.projected);
  expect(forecast.days[30]?.lastMonthCumulative).toBeNull();
  expect(forecast.days[29]?.lastMonthCumulative).toBe(90);
});

test('a younger history averages over the days it has', () => {
  const points = [day('2026-10-08', 6), day('2026-10-09', 2)];

  const forecast = spendForecast(points, new Date('2026-10-10T00:00:00Z'));

  expect(forecast.runRate).toBe(4);
});

test('with no full day of history there is nothing to project', () => {
  const forecast = spendForecast([day('2026-10-10', 5)], new Date('2026-10-10T08:00:00Z'));

  expect(forecast.monthToDate).toBe(5);
  expect(forecast.runRate).toBeNull();
  expect(forecast.projected).toBeNull();
});
