/**
 * Timing, statistics and reporting.
 *
 * Deliberately free of anything log-specific so the scenario list stays the
 * only thing that has to change when the next axis gets stressed.
 */

export interface Scenario {
  name: string;

  /**
   * Runs the thing once.
   *
   * Returns how many rows came back, which the report prints alongside the
   * timings. That column is not decoration: the failure mode of a read
   * benchmark is a query that got fast because it stopped returning anything,
   * and a scenario that reports 0 rows against a seeded set is the loudest
   * possible way to say so.
   */
  run: () => Promise<number>;
}

export interface Result {
  name: string;
  rows: number;
  iterations: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;

  /**
   * Why this scenario has no timings.
   *
   * A scenario that throws is recorded rather than propagated. One broken read
   * path should not cost the other ten their measurements - and at these run
   * times, "start again" is minutes of seeding. The report prints the message
   * underneath the table so a failure cannot be mistaken for a fast row.
   */
  error?: string;
}

/**
 * Nearest-rank percentile.
 *
 * Not interpolated. With the sample counts this harness runs - tens, not
 * thousands - interpolating between two measurements invents a number that was
 * never observed, and "the 95th percentile is one of the samples" is the more
 * honest claim.
 */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const rank = Math.ceil(fraction * sorted.length);

  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

export interface MeasureOptions {
  /**
   * Runs discarded before measuring.
   *
   * The first execution of a query pays for parse, plan, and pulling pages off
   * disk into the buffer cache - none of which recur. Reporting it alongside
   * the steady-state runs would put a 40ms outlier in every max column and make
   * the numbers unreadable at exactly the point they start to matter.
   */
  warmup: number;

  iterations: number;
}

export async function measure(scenario: Scenario, options: MeasureOptions): Promise<Result> {
  const samples: number[] = [];
  let rows = 0;

  try {
    for (let run = 0; run < options.warmup; run++) {
      await scenario.run();
    }

    for (let run = 0; run < options.iterations; run++) {
      const started = performance.now();
      rows = await scenario.run();
      samples.push(performance.now() - started);
    }
  } catch (error) {
    return {
      name: scenario.name,
      rows: 0,
      iterations: 0,
      min: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      error: error instanceof Error ? error.message.replaceAll(/\s+/g, ' ').trim() : String(error),
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  return {
    name: scenario.name,
    rows: rows,
    iterations: options.iterations,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN,
    mean: samples.reduce((total, sample) => total + sample, 0) / (samples.length || 1),
  };
}

function milliseconds(value: number): string {
  if (Number.isNaN(value)) {
    return '-';
  }

  return value >= 100 ? `${value.toFixed(0)}ms` : `${value.toFixed(2)}ms`;
}

/** Renders the results as a fixed-width table, failures called out below it. */
export function report(results: Result[]): string {
  const columns = [
    { header: 'scenario', align: 'left' as const, of: (result: Result) => result.name },
    {
      header: 'rows',
      align: 'right' as const,
      of: (result: Result) => (result.error ? 'FAILED' : result.rows.toLocaleString('en-US')),
    },
    { header: 'min', align: 'right' as const, of: (result: Result) => milliseconds(result.min) },
    { header: 'p50', align: 'right' as const, of: (result: Result) => milliseconds(result.p50) },
    { header: 'p95', align: 'right' as const, of: (result: Result) => milliseconds(result.p95) },
    { header: 'p99', align: 'right' as const, of: (result: Result) => milliseconds(result.p99) },
    { header: 'max', align: 'right' as const, of: (result: Result) => milliseconds(result.max) },
  ];

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...results.map((result) => column.of(result).length)),
  );

  const line = (cells: string[]) =>
    cells
      .map((cell, index) => {
        const width = widths[index] as number;
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  const failures = results.filter((result) => result.error);

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...results.map((result) => line(columns.map((column) => column.of(result)))),
    ...(failures.length === 0
      ? []
      : ['', 'failures:', ...failures.map((failure) => `  ${failure.name}: ${failure.error}`)]),
  ].join('\n');
}
