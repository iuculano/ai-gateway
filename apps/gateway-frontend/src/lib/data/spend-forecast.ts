const DAY = 86_400_000;

// How many full days back the run rate is averaged over.
const RATE_DAYS = 7;

export interface ForecastDay {
  /** Midnight UTC, which is how analytics buckets days. */
  date: Date;
  /** What was spent; null for days still to come. */
  actual: number | null;
  /** The run rate, for days still to come; null for days already counted. */
  projected: number | null;
  /** The month's running total through this day; null for days still to come. */
  cumulative: number | null;
  /**
   * Where the running total gets to by the end of this day at the run rate:
   * from today (where it equals the total so far) to the month's last day
   * (where it equals the projection). Null before today, or with no run rate.
   */
  projectedCumulative: number | null;
  /** Last month's running total through the same day of the month; null past its end. */
  lastMonthCumulative: number | null;
}

/**
 * This month's spend so far, and where it lands at month end if the last week's
 * pace holds.
 *
 * Months and days are UTC, matching the analytics buckets. The run rate averages
 * the last 7 full days, or fewer when the history is younger than that; with no
 * full day of history there's nothing to project from, so projected is null.
 *
 * @param points
 * Daily spend, from the start of last month up to now.
 *
 * @param now
 * The moment to forecast from.
 */
export function spendForecast(points: { bucket: Date | string | null; cost_total: number }[], now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const lastMonthStart = Date.UTC(year, month - 1, 1);
  const today = Date.UTC(year, month, now.getUTCDate());

  const spendByDay = new Map<number, number>();
  let firstDay: number | null = null;
  for (const point of points) {
    if (!point.bucket) continue;
    const day = new Date(point.bucket).getTime();
    spendByDay.set(day, (spendByDay.get(day) ?? 0) + point.cost_total);
    if (point.cost_total > 0 && (firstDay === null || day < firstDay)) firstDay = day;
  }

  let monthToDate = 0;
  let lastMonth = 0;
  let rateSpend = 0;
  const rateStart = Math.max(today - RATE_DAYS * DAY, firstDay ?? today);
  for (const [day, spend] of spendByDay) {
    if (day >= monthStart) monthToDate += spend;
    else if (day >= lastMonthStart) lastMonth += spend;
    if (day >= rateStart && day < today) rateSpend += spend;
  }

  // Last month, day by day, and how far it had got by this point in the month:
  // the days before today's date, plus the same share of that day as has gone
  // by today, so a morning isn't compared with a whole day.
  const lastMonthDaily = [];
  for (let day = lastMonthStart; day < monthStart; day += DAY) lastMonthDaily.push(spendByDay.get(day) ?? 0);
  const dayIndex = now.getUTCDate() - 1;
  let lastMonthToDate = 0;
  for (const [index, spend] of lastMonthDaily.entries()) {
    if (index < dayIndex) lastMonthToDate += spend;
    else if (index === dayIndex) lastMonthToDate += (spend * (now.getTime() - today)) / DAY;
  }

  const rateDays = (today - rateStart) / DAY;
  const runRate = rateDays > 0 ? rateSpend / rateDays : null;
  // The rest of today counts at the run rate too, pro rata.
  const projected = runRate === null ? null : monthToDate + (runRate * (nextMonthStart - now.getTime())) / DAY;

  const days: ForecastDay[] = [];
  let running = 0;
  let lastRunning = 0;
  for (let day = monthStart, index = 0; day < nextMonthStart; day += DAY, index++) {
    const actual = day <= today ? (spendByDay.get(day) ?? 0) : null;
    running += actual ?? 0;
    const lastMonthSpend = lastMonthDaily[index];
    lastRunning += lastMonthSpend ?? 0;
    // Through the end of this day, at the run rate from now.
    const dayEnd = Math.min(day + DAY, nextMonthStart);
    days.push({
      date: new Date(day),
      actual,
      projected: day > today ? runRate : null,
      cumulative: actual === null ? null : running,
      projectedCumulative:
        runRate === null || day < today
          ? null
          : day === today
            ? monthToDate
            : monthToDate + (runRate * (dayEnd - now.getTime())) / DAY,
      lastMonthCumulative: lastMonthSpend === undefined ? null : lastRunning,
    });
  }

  return { monthToDate, projected, lastMonth, lastMonthToDate, runRate, days };
}
