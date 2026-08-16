import { expect, test } from 'bun:test';
import { distribution, runConstantRate } from '../stress/load-harness';

test('load distributions use observed nearest-rank percentiles', () => {
  expect(distribution([50, 10, 30, 20, 40])).toEqual({
    min: 10,
    p50: 30,
    p95: 50,
    p99: 50,
    max: 50,
    mean: 30,
  });
});

test('constant-rate load drops arrivals instead of queueing past the concurrency cap', async () => {
  const result = await runConstantRate({
    name: 'saturation',
    ratePerSecond: 100,
    durationSeconds: 0.02,
    maxConcurrency: 1,
    run: async () => {
      await Bun.sleep(40);
      return { status: 200, latencyMs: 40 };
    },
  });

  expect(result.scheduled).toBe(2);
  expect(result.started).toBe(1);
  expect(result.dropped).toBe(1);
  expect(result.succeeded).toBe(1);
  expect(result.error_rate).toBe(0.5);
});
