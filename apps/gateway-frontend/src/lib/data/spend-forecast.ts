const DAY = 86_400_000;

// How many full days back the run rate is averaged over.
const RATE_DAYS = 7;

export interface ForecastDay {
  /**
   * Midnight UTC, which is how analytics buckets days.
   */
  date: Date;

  /**
   * What was spent, or null for days still to come.
   */
  actual: number | null;

  /**
   * The run rate for days still to come, or null for days already counted.
   */
  projected: number | null;

  /**
   * The month's running total through this day, or null for days still to come.
   */
  cumulative: number | null;

  /**
   * Where the running total gets to by the end of this day at the run rate.
   * It runs from today, where it equals the total so far, to the month's last
   * day, where it equals the projection. Null before today or with no run rate.
   */
  projectedCumulative: number | null;

  /**
   * Last month's running total through the same day of the month, or null past
   * its end.
   */
  lastMonthCumulative: number | null;
}

/**
 * The month's totals, its run rate and a row for each of its days. The run
 * rate and the projection are null when there is no full day of history to go
 * on.
 */
export interface SpendForecast {
  monthToDate: number;
  projected: number | null;
  lastMonth: number;
  lastMonthToDate: number;
  runRate: number | null;
  days: ForecastDay[];
}

/**
 * This month's spend so far, and where it lands at month end if the last week's
 * pace holds.
 *
 * @param points
 * Daily spend, from the start of last month up to now.
 *
 * @param now
 * The moment to forecast from.
 */
export function spendForecast(
  points: { bucket: Date | string | null; cost_total: number }[],
  now: Date,
): SpendForecast {
  // Months and days are UTC, matching the analytics buckets.
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const lastMonthStart = Date.UTC(year, month - 1, 1);
  const today = Date.UTC(year, month, now.getUTCDate());

  const spendByDay = new Map<number, number>();
  let firstDay: number | null = null;

  for (const point of points) {
    if (!point.bucket) {
      continue;
    }

    const day = new Date(point.bucket).getTime();
    spendByDay.set(day, (spendByDay.get(day) ?? 0) + point.cost_total);

    if (point.cost_total > 0 && (firstDay === null || day < firstDay)) {
      firstDay = day;
    }
  }

  // The run rate averages the last full days, or fewer when the history is
  // younger than that.
  const rateStart = Math.max(today - RATE_DAYS * DAY, firstDay ?? today);
  let monthToDate = 0;
  let lastMonth = 0;
  let rateSpend = 0;

  for (const [day, spend] of spendByDay) {
    if (day >= monthStart) {
      monthToDate += spend;
    } else if (day >= lastMonthStart) {
      lastMonth += spend;
    }

    if (day >= rateStart && day < today) {
      rateSpend += spend;
    }
  }

  const lastMonthDaily: number[] = [];

  for (let day = lastMonthStart; day < monthStart; day += DAY) {
    lastMonthDaily.push(spendByDay.get(day) ?? 0);
  }

  // How far last month had got by this point in the month, which is the days
  // before today's date plus the same share of that day as has gone by today,
  // so a morning is not compared with a whole day.
  const dayIndex = now.getUTCDate() - 1;
  const elapsedToday = now.getTime() - today;
  let lastMonthToDate = 0;

  for (const [index, spend] of lastMonthDaily.entries()) {
    if (index < dayIndex) {
      lastMonthToDate += spend;
    } else if (index === dayIndex) {
      lastMonthToDate += (spend * elapsedToday) / DAY;
    }
  }

  const rateDays = (today - rateStart) / DAY;
  const runRate = rateDays > 0 ? rateSpend / rateDays : null;

  // The rest of today counts at the run rate too, pro rata.
  const remaining = nextMonthStart - now.getTime();
  const projected = runRate === null ? null : monthToDate + (runRate * remaining) / DAY;

  const days: ForecastDay[] = [];
  let running = 0;
  let lastRunning = 0;

  for (let day = monthStart, index = 0; day < nextMonthStart; day += DAY, index++) {
    const actual = day <= today ? (spendByDay.get(day) ?? 0) : null;
    const lastMonthSpend = lastMonthDaily[index];

    running += actual ?? 0;
    lastRunning += lastMonthSpend ?? 0;

    let projectedCumulative: number | null = null;

    if (runRate !== null && day === today) {
      projectedCumulative = monthToDate;
    } else if (runRate !== null && day > today) {
      // Through the end of this day, at the run rate from now.
      const dayEnd = Math.min(day + DAY, nextMonthStart);

      projectedCumulative = monthToDate + (runRate * (dayEnd - now.getTime())) / DAY;
    }

    days.push({
      date: new Date(day),
      actual: actual,
      projected: day > today ? runRate : null,
      cumulative: actual === null ? null : running,
      projectedCumulative: projectedCumulative,
      lastMonthCumulative: lastMonthSpend === undefined ? null : lastRunning,
    });
  }

  return { monthToDate, projected, lastMonth, lastMonthToDate, runRate, days };
}
