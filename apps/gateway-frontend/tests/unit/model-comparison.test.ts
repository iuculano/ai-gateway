import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { modelComparisonRows, sortModelRows } from '../../src/lib/data/model-comparison';

function point(provider: string, overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    provider,
    model: 'shared-model',
    requests: 10,
    cost_total: 2,
    input_tokens: 1500,
    output_tokens: 500,
    total_tokens: 2000,
    average_latency_ms: 500,
    ...overrides,
  } as SeriesPoint;
}

test('computes cost and failure rates per provider/model without averaging latency groups', () => {
  const rows = modelComparisonRows([point('openai'), point('azure')], [point('azure', { requests: 2 })]);
  expect(rows[0]).toMatchObject({ averageCost: 0.2, latency: 500, errorRate: 0 });
  expect(rows[1]).toMatchObject({ averageCost: 0.2, errorRate: 20 });
  expect(rows[0]?.id).not.toBe(rows[1]?.id);
});

test('efficiency uses total tokens for blended cost and request size, and input/output for mix', () => {
  const [row] = modelComparisonRows([point('openai')], []);
  expect(row).toMatchObject({ costPerMillion: 1000, tokensPerRequest: 200, inputShare: 75 });
  const [empty] = modelComparisonRows(
    [
      point('openai', {
        requests: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    ],
    [],
  );
  expect(empty).toMatchObject({ costPerMillion: null, tokensPerRequest: null, inputShare: null });
  const [free] = modelComparisonRows([point('openai', { cost_total: 0 })], []);
  expect(free?.costPerMillion).toBe(0);
  expect(
    sortModelRows(
      [empty, row, free].filter((value) => value !== undefined),
      'costPerMillion',
      true,
    ).map((r) => r.costPerMillion),
  ).toEqual([0, 1000, null]);
});

test('zero requests leave ratios unavailable', () => {
  expect(modelComparisonRows([point('openai', { requests: 0, cost_total: 0 })], [])[0]).toMatchObject({
    averageCost: null,
    errorRate: null,
  });
});

test('numeric sorting works in both directions and leaves missing latency last', () => {
  const rows = modelComparisonRows(
    [
      point('a', { requests: 2, average_latency_ms: null }),
      point('b', { requests: 100, average_latency_ms: 900 }),
      point('c', { requests: 10, average_latency_ms: 200 }),
    ],
    [],
  );
  expect(sortModelRows(rows, 'requests', false).map((row) => row.requests)).toEqual([100, 10, 2]);
  expect(sortModelRows(rows, 'latency', false).map((row) => row.latency)).toEqual([900, 200, null]);
  expect(sortModelRows(rows, 'latency', true).map((row) => row.latency)).toEqual([200, 900, null]);
  expect(rows.map((row) => row.requests)).toEqual([2, 100, 10]);
});
