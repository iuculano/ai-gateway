import { beforeEach, describe, expect, test } from 'bun:test';
import { database, installModuleMocks, LOG_ID, logRow, resetDoubles, rows } from './doubles';

/**
 * getLogStats, which counts exactly when that is cheap and samples when it is not.
 *
 * Neither mode was covered. The sampled one is the more interesting: the total
 * comes from the planner, the breakdown from a single TABLESAMPLE, and the two
 * are reconciled by scaling the sample's SUMS. Getting that arithmetic wrong
 * produces numbers that look plausible and are quietly several times too large,
 * which is exactly the kind of error a test is for.
 */

await installModuleMocks();

const { default: Services } = await import('../../src/api/logs/logs.services');

/** Mirrors EXACT_THRESHOLD in the service. */
const EXACT_THRESHOLD = 100_000;

beforeEach(() => {
  resetDoubles();
});

/** What the capped count returns - it decides which branch runs. */
function capped(total: number) {
  return rows({ total });
}

/**
 * A sample row shaped like the real query's projection.
 *
 * Every column spelled out because the scaled branch multiplies them directly -
 * `Number(sample.input_cost) * scale` - with no fallback. The SQL COALESCEs all
 * of them so a column can never actually be missing, but a fixture that omits
 * one produces NaN rather than a wrong number, which is a fixture bug wearing a
 * service bug's clothes.
 */
function sampleRow(overrides: Record<string, unknown> = {}) {
  return rows({
    sampled: 10,
    complete: 10,
    failed: 0,
    incomplete: 0,
    input_tokens: '0',
    output_tokens: '0',
    input_cost: '0',
    output_cost: '0',
    ...overrides,
  });
}

/** An EXPLAIN (format json) result carrying a planner row estimate. */
function explain(planRows: unknown, { asString = false } = {}) {
  const plan = [{ Plan: { 'Plan Rows': planRows } }];
  return rows({ 'QUERY PLAN': asString ? JSON.stringify(plan) : plan });
}

describe('exact mode', () => {
  test('counts everything and does not flag the result as estimated', async () => {
    database.script(
      capped(42),
      rows({
        complete: 10,
        failed: 2,
        incomplete: 1,
        input_tokens: '100',
        output_tokens: '50',
        input_cost: '1.5',
        output_cost: '2.5',
      }),
    );

    const stats = await Services.getLogStats();

    expect(stats.estimated).toBe(false);
    expect(stats.by_status).toEqual({ complete: 10, failed: 2, incomplete: 1 });

    // Added from the three statuses rather than carried separately, so the
    // headline can never disagree with the breakdown beside it.
    expect(stats.total).toBe(13);
    expect(stats.tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(stats.cost).toEqual({ input: 1.5, output: 2.5, total: 4 });
  });

  test('a tenant with no logs gets zeroes rather than nulls', async () => {
    // sum() over an empty set returns null; the query COALESCEs it, and an
    // absent row has to end up at zero too rather than NaN.
    database.script(capped(0), rows());

    const stats = await Services.getLogStats();

    expect(stats.total).toBe(0);
    expect(stats.estimated).toBe(false);
    expect(stats.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(stats.cost).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('exactly at the threshold still counts rather than samples', async () => {
    // The capped count asks for THRESHOLD + 1, so landing on the threshold
    // means the count is exact and the estimate is never needed. Two scripted
    // queries, not three - a third would mean the sampled branch ran.
    database.script(capped(EXACT_THRESHOLD), rows({ complete: EXACT_THRESHOLD }));

    const stats = await Services.getLogStats();

    expect(stats.estimated).toBe(false);
    expect(stats.total).toBe(EXACT_THRESHOLD);
  });
});

describe('sampled mode', () => {
  test('scales the sample by the planner estimate', async () => {
    database.script(
      capped(EXACT_THRESHOLD + 1),
      explain(5_000_000),
      rows({
        sampled: 100,
        complete: 80,
        failed: 15,
        incomplete: 5,
        input_tokens: '1000',
        output_tokens: '500',
        input_cost: '10',
        output_cost: '20',
      }),
    );

    const stats = await Services.getLogStats();

    // scale = 5,000,000 / 100 = 50,000.
    expect(stats.estimated).toBe(true);
    expect(stats.by_status).toEqual({ complete: 4_000_000, failed: 750_000, incomplete: 250_000 });
    expect(stats.total).toBe(5_000_000);
    expect(stats.tokens).toEqual({ input: 50_000_000, output: 25_000_000, total: 75_000_000 });
    expect(stats.cost).toEqual({ input: 500_000, output: 1_000_000, total: 1_500_000 });
  });

  test('a sample that caught none of the tenant attributes the total to complete', async () => {
    // Reachable when the tenant's rows are clustered into pages the sample
    // missed. Reporting a confident zero would be worse than saying "about this
    // many, status unknown", and dividing by the sample size would be worse
    // still.
    database.script(capped(EXACT_THRESHOLD + 1), explain(3_000_000), sampleRow({ sampled: 0, complete: 0 }));

    const stats = await Services.getLogStats();

    expect(stats.estimated).toBe(true);
    expect(stats.total).toBe(3_000_000);
    expect(stats.by_status).toEqual({ complete: 3_000_000, failed: 0, incomplete: 0 });
  });

  test('no sample row at all is handled the same way', async () => {
    database.script(capped(EXACT_THRESHOLD + 1), explain(1_000), rows());

    const stats = await Services.getLogStats();

    expect(stats.total).toBe(1_000);
    expect(stats.estimated).toBe(true);
  });
});

describe('the planner estimate', () => {
  test('is read from a plan the driver already parsed', async () => {
    database.script(capped(EXACT_THRESHOLD + 1), explain(2_500_000), sampleRow());

    expect((await Services.getLogStats()).total).toBe(2_500_000);
  });

  test('is read from a plan handed back as a string', async () => {
    // EXPLAIN may arrive as text rather than parsed json - valid output, and
    // cheaper to handle than to rule out.
    database.script(capped(EXACT_THRESHOLD + 1), explain(1_200_000, { asString: true }), sampleRow());

    expect((await Services.getLogStats()).total).toBe(1_200_000);
  });

  test('falls back to zero when the plan carries no usable estimate', async () => {
    // A shape change upstream must not turn into NaN in a dashboard.
    database.script(capped(EXACT_THRESHOLD + 1), rows({ 'QUERY PLAN': [{}] }), sampleRow());

    const stats = await Services.getLogStats();

    expect(stats.total).toBe(0);
    expect(Number.isNaN(stats.total)).toBe(false);
  });

  test('a non-numeric estimate is rejected rather than propagated', async () => {
    database.script(capped(EXACT_THRESHOLD + 1), explain('not a number'), sampleRow());

    expect((await Services.getLogStats()).total).toBe(0);
  });

  test('an empty EXPLAIN result does not throw', async () => {
    database.script(capped(EXACT_THRESHOLD + 1), rows(), sampleRow());

    expect((await Services.getLogStats()).total).toBe(0);
  });
});

describe('startLog', () => {
  test('throws when the insert returns nothing to identify the log by', async () => {
    // Every later write is keyed on this id, so continuing without one would
    // silently drop the request's entire record.
    database.script(rows());

    expect(Services.startLog('org', { model: 'gpt-5', provider: 'openai' } as never)).rejects.toThrow(
      'Failed to open log',
    );
  });

  test('returns the new id on success', async () => {
    database.script(rows(logRow({ id: LOG_ID })));

    expect(await Services.startLog('org', { model: 'gpt-5', provider: 'openai' } as never)).toBe(LOG_ID);
  });
});
