// Percentiles as the analytics endpoints send them, ninety-nine values from p1
// to p99.

/**
 * The value at one percentile, or zero when there is none.
 */
export function percentileAt(percentiles: number[], percentile: number): number {
  // The list starts at p1, so the fiftieth percentile is the fiftieth entry.
  return percentiles[percentile - 1] ?? 0;
}

/**
 * How many of the percentiles a value is above, which is roughly the share of
 * the population it beats, from 0 to 99.
 */
export function percentileRank(percentiles: number[], value: number): number {
  return percentiles.filter((percentile) => percentile < value).length;
}
