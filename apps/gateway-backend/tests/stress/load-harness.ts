/**
 * Constant-arrival-rate load generation and reporting.
 *
 * Kept independent of the gateway so the scheduler and statistics can be unit
 * tested without PostgreSQL, Redis, MinIO, or a running HTTP server.
 */

export interface RequestSample {
  status: number;
  latencyMs: number;
  firstByteMs?: number;
  error?: string;
  invariantFailures?: string[];
}

export interface LoadScenario {
  name: string;
  ratePerSecond: number;
  durationSeconds: number;
  maxConcurrency: number;
  run: (sequence: number) => Promise<RequestSample>;
}

export interface Distribution {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface LoadResult {
  name: string;
  target_rps: number;
  duration_seconds: number;
  elapsed_seconds: number;
  scheduled: number;
  started: number;
  completed: number;
  succeeded: number;
  failed: number;
  dropped: number;
  achieved_rps: number;
  completion_rps: number;
  error_rate: number;
  max_concurrency: number;
  latency_ms: Distribution;
  first_byte_ms?: Distribution;
  statuses: Record<string, number>;
  errors: Record<string, number>;
  invariant_failures: Record<string, number>;
}

const EMPTY_DISTRIBUTION: Distribution = {
  min: Number.NaN,
  p50: Number.NaN,
  p95: Number.NaN,
  p99: Number.NaN,
  max: Number.NaN,
  mean: Number.NaN,
};

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

export function distribution(samples: number[]): Distribution {
  if (samples.length === 0) {
    return { ...EMPTY_DISTRIBUTION };
  }

  const sorted = [...samples].sort((left, right) => left - right);

  return {
    min: sorted[0] as number,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) as number,
    mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
  };
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function asRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Starts requests at fixed wall-clock intervals.
 *
 * This is deliberately open-loop: a slow gateway does not reduce the offered
 * rate and flatter itself. Once maxConcurrency is occupied, arrivals are
 * counted as dropped instead of being queued and quietly turning a 100 RPS
 * scenario into a much longer lower-rate run.
 */
export async function runConstantRate(scenario: LoadScenario): Promise<LoadResult> {
  const scheduled = Math.floor(scenario.ratePerSecond * scenario.durationSeconds);
  const intervalMs = 1000 / scenario.ratePerSecond;
  const samples: RequestSample[] = [];
  const running = new Set<Promise<void>>();

  let dropped = 0;
  let peakConcurrency = 0;
  const startedAt = performance.now();

  for (let sequence = 0; sequence < scheduled; sequence++) {
    const dueAt = startedAt + sequence * intervalMs;
    const waitMs = dueAt - performance.now();
    if (waitMs > 0) {
      await Bun.sleep(waitMs);
    }

    if (running.size >= scenario.maxConcurrency) {
      dropped++;
      continue;
    }

    let task: Promise<void>;
    task = scenario
      .run(sequence)
      .then((sample) => {
        samples.push(sample);
      })
      .catch((error) => {
        samples.push({
          status: 0,
          latencyMs: performance.now() - dueAt,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running.delete(task);
      });

    running.add(task);
    peakConcurrency = Math.max(peakConcurrency, running.size);
  }

  // The final scheduled request starts one interval before the end of the
  // stage. Keep the stage clock open for the full configured duration before
  // draining outstanding responses; otherwise a 2 RPS / 1 second run finishes
  // at roughly 0.5 seconds and misleadingly reports almost 4 completions/sec.
  const stageRemainingMs = startedAt + scenario.durationSeconds * 1000 - performance.now();
  if (stageRemainingMs > 0) {
    await Bun.sleep(stageRemainingMs);
  }

  await Promise.all(running);

  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const statuses = new Map<string, number>();
  const errors = new Map<string, number>();
  const invariantFailures = new Map<string, number>();

  for (const sample of samples) {
    increment(statuses, sample.status === 0 ? 'network' : String(sample.status));
    if (sample.error) {
      increment(errors, sample.error);
    }
    for (const failure of sample.invariantFailures ?? []) {
      increment(invariantFailures, failure);
    }
  }

  const succeeded = samples.filter((sample) => sample.status >= 200 && sample.status < 300 && !sample.error).length;
  const failed = samples.length - succeeded;
  const firstByteSamples = samples.flatMap((sample) => (sample.firstByteMs === undefined ? [] : [sample.firstByteMs]));

  return {
    name: scenario.name,
    target_rps: scenario.ratePerSecond,
    duration_seconds: scenario.durationSeconds,
    elapsed_seconds: elapsedSeconds,
    scheduled,
    started: samples.length,
    completed: samples.length,
    succeeded,
    failed,
    dropped,
    achieved_rps: samples.length / scenario.durationSeconds,
    completion_rps: samples.length / Math.max(elapsedSeconds, 0.001),
    error_rate: (failed + dropped) / Math.max(scheduled, 1),
    max_concurrency: peakConcurrency,
    latency_ms: distribution(samples.map((sample) => sample.latencyMs)),
    ...(firstByteSamples.length > 0 ? { first_byte_ms: distribution(firstByteSamples) } : {}),
    statuses: asRecord(statuses),
    errors: asRecord(errors),
    invariant_failures: asRecord(invariantFailures),
  };
}

function milliseconds(value: number): string {
  if (Number.isNaN(value)) {
    return '-';
  }

  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

/** Fixed-width summary for terminals and build logs. */
export function reportLoad(results: LoadResult[]): string {
  const columns = [
    { header: 'scenario', align: 'left' as const, value: (result: LoadResult) => result.name },
    { header: 'target', align: 'right' as const, value: (result: LoadResult) => result.target_rps.toString() },
    { header: 'started', align: 'right' as const, value: (result: LoadResult) => result.started.toString() },
    { header: 'drop', align: 'right' as const, value: (result: LoadResult) => result.dropped.toString() },
    { header: 'errors', align: 'right' as const, value: (result: LoadResult) => percentage(result.error_rate) },
    { header: 'rps', align: 'right' as const, value: (result: LoadResult) => result.completion_rps.toFixed(1) },
    { header: 'p50 ms', align: 'right' as const, value: (result: LoadResult) => milliseconds(result.latency_ms.p50) },
    { header: 'p95 ms', align: 'right' as const, value: (result: LoadResult) => milliseconds(result.latency_ms.p95) },
    { header: 'p99 ms', align: 'right' as const, value: (result: LoadResult) => milliseconds(result.latency_ms.p99) },
    {
      header: 'ttfb p95',
      align: 'right' as const,
      value: (result: LoadResult) => milliseconds(result.first_byte_ms?.p95 ?? Number.NaN),
    },
  ];

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...results.map((result) => column.value(result).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => {
        const width = widths[index] as number;
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...results.map((result) => line(columns.map((column) => column.value(result)))),
  ].join('\n');
}
