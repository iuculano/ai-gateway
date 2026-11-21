import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import { modelChangeRows, modelComparisonRows, sortModelRows } from '../../src/lib/data/model-comparison';

function point(provider: string, overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    provider: provider,
    model: 'shared-model',
    requests: 10,
    gateway_cache_hits: 0,
    cost_total: 2,
    input_tokens: 1500,
    output_tokens: 500,
    total_tokens: 2000,
    median_latency_ms: 500,
    ...overrides,
  } as SeriesPoint;
}

// modelComparisonRows

test('the same model on two providers is two rows, each with its own failure rate', () => {
  const totals = [point('openai'), point('azure')];
  const failures = [point('azure', { requests: 2 })];

  const [openai, azure] = modelComparisonRows(totals, failures);

  expect(openai).toMatchObject({ averageCost: 0.2, latency: 500, errorRate: 0 });
  expect(azure).toMatchObject({ averageCost: 0.2, errorRate: 20 });
  expect(openai?.id).not.toBe(azure?.id);
});

test('efficiency prices total tokens and splits the mix by input and output', () => {
  const [row] = modelComparisonRows([point('openai')], []);

  expect(row).toMatchObject({ costPerMillion: 1000, tokensPerRequest: 200, inputShare: 75 });
});

test('requests answered from the gateway cache do not dilute tokens per request', () => {
  // Half were cache hits, so the tokens all came from the other half.
  const [row] = modelComparisonRows([point('openai', { gateway_cache_hits: 5 })], []);

  expect(row?.tokensPerRequest).toBe(400);
});

test('a free model costs zero per million tokens rather than nothing', () => {
  const [row] = modelComparisonRows([point('openai', { cost_total: 0 })], []);

  expect(row?.costPerMillion).toBe(0);
});

test('a model with no traffic has no ratios', () => {
  const idle = point('openai', { requests: 0, cost_total: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0 });

  const [row] = modelComparisonRows([idle], []);

  expect(row).toMatchObject({
    averageCost: null,
    errorRate: null,
    costPerMillion: null,
    tokensPerRequest: null,
    inputShare: null,
  });
});

// sortModelRows

test('sorting works in both directions and leaves the input order alone', () => {
  const totals = [point('a', { requests: 2 }), point('b', { requests: 100 }), point('c', { requests: 10 })];
  const rows = modelComparisonRows(totals, []);

  const descending = sortModelRows(rows, 'requests', false);
  const ascending = sortModelRows(rows, 'requests', true);

  expect(descending.map((row) => row.requests)).toEqual([100, 10, 2]);
  expect(ascending.map((row) => row.requests)).toEqual([2, 10, 100]);
  expect(rows.map((row) => row.requests)).toEqual([2, 100, 10]);
});

test('a missing measurement sorts last in either direction', () => {
  // The missing one sits between the others so it is compared from both sides.
  const totals = [
    point('a', { median_latency_ms: 900 }),
    point('b', { median_latency_ms: null }),
    point('c', { median_latency_ms: 200 }),
  ];
  const rows = modelComparisonRows(totals, []);

  const descending = sortModelRows(rows, 'latency', false);
  const ascending = sortModelRows(rows, 'latency', true);

  expect(descending.map((row) => row.latency)).toEqual([900, 200, null]);
  expect(ascending.map((row) => row.latency)).toEqual([200, 900, null]);
});

// modelChangeRows

test('changes cover models from either window, biggest move first', () => {
  const current = [
    point('openai', { model: 'kept', cost_total: 12 }),
    point('openai', { model: 'new', cost_total: 5 }),
  ];
  const previous = [
    point('openai', { model: 'kept', cost_total: 10 }),
    point('openai', { model: 'retired', cost_total: 8 }),
  ];

  const rows = modelChangeRows(current, previous, 'cost_total');

  // A retired model still explains where the spend went.
  expect(rows.map((row) => [row.model, row.change])).toEqual([
    ['retired', -8],
    ['new', 5],
    ['kept', 2],
  ]);
});

test('a percentage is only given where there was something to compare against', () => {
  const current = [point('openai', { model: 'kept', requests: 15 }), point('openai', { model: 'new', requests: 4 })];
  const previous = [point('openai', { model: 'kept', requests: 10 })];

  const [kept, added] = modelChangeRows(current, previous, 'requests');

  expect(kept).toMatchObject({ model: 'kept', percentage: 50 });
  expect(added).toMatchObject({ model: 'new', percentage: null });
});
