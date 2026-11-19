import { expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/lib/api/analytics';
import {
  cacheSaved,
  cheapestSwitch,
  costAt,
  idleKeys,
  type KeySummary,
  type ModelPrice,
  type ModelUsage,
  rankKeys,
  usageByModel,
} from '../../src/lib/data/savings';

const point = (fields: Partial<SeriesPoint>) =>
  ({
    actor_type: 'api_key',
    actor_id: 'key-a',
    provider: 'openai',
    model: 'gpt-big',
    requests: 0,
    gateway_cache_hits: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_total: 0,
    ...fields,
  }) as SeriesPoint;

const usage: ModelUsage = {
  provider: 'openai',
  model: 'gpt-big',
  requests: 10,
  gatewayCacheHits: 2,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cost: 20,
};

const price = (name: string, cost_input: number | null, cost_output: number | null, type = 'chat'): ModelPrice => ({
  provider: 'openai',
  name,
  type,
  cost_input,
  cost_output,
});

const key = (id: string, created_at: string, fields: Partial<KeySummary> = {}): KeySummary => ({
  id,
  name: id,
  created_at,
  revoked_at: null,
  expires_at: null,
  total_requests: 0,
  ...fields,
});

test('sums actors down to one row per model, biggest spend first', () => {
  const rows = usageByModel([
    point({ actor_id: 'key-a', cost_total: 1, requests: 2 }),
    point({ actor_id: 'key-b', cost_total: 2, requests: 3 }),
    point({ model: 'gpt-huge', cost_total: 9, requests: 1 }),
  ]);

  expect(rows.map((row) => [row.model, row.cost, row.requests])).toEqual([
    ['gpt-huge', 9, 1],
    ['gpt-big', 3, 5],
  ]);
});

test('reprices tokens at per-million prices, and refuses an unpriced model', () => {
  expect(costAt(usage, price('gpt-small', 1, 2))).toBe(2);
  expect(costAt(usage, price('gpt-free', null, null))).toBeNull();
});

test('picks the cheapest chat model that saves money', () => {
  const candidates = [
    price('gpt-big', 0, 0), // itself
    price('gpt-mid', 4, 8),
    price('gpt-small', 1, 2),
    price('embed', 0, 0, 'embedding'),
    price('gpt-unpriced', null, null),
  ];

  expect(cheapestSwitch(usage, candidates)).toEqual({ price: candidates[2] as ModelPrice, cost: 2 });
  expect(cheapestSwitch(usage, [price('gpt-pricier', 100, 100)])).toBeNull();
});

test('values cache hits at the average cost of the requests that were answered', () => {
  expect(cacheSaved(usage)).toBe(5);
  expect(cacheSaved({ ...usage, requests: 2, gatewayCacheHits: 2, cost: 0 })).toBeNull();
});

test('ranks keys by spend, against all callers and the window before', () => {
  const ranked = rankKeys(
    [
      point({ actor_id: 'key-a', model: 'gpt-big', cost_total: 6, requests: 1 }),
      point({ actor_id: 'key-a', model: 'gpt-small', cost_total: 2, requests: 4 }),
      point({ actor_id: 'key-b', cost_total: 1, requests: 1 }),
      point({ actor_type: 'user', actor_id: 'person', cost_total: 1, requests: 1 }),
    ],
    [point({ actor_id: 'key-a', cost_total: 4 })],
  );

  expect(ranked.map((row) => row.id)).toEqual(['key-a', 'key-b']);
  expect(ranked[0]).toMatchObject({
    cost: 8,
    requests: 5,
    share: 0.8,
    previous: 4,
    topModel: 'openai/gpt-big',
    topModelShare: 0.75,
  });
  expect(ranked[1]?.previous).toBe(0);
});

test('idle keys are live, older than the window, and without traffic in it', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const now = new Date('2026-10-31T00:00:00Z');
  const keys = [
    key('newer-idle', '2026-09-02T00:00:00Z'),
    key('older-idle', '2026-09-01T00:00:00Z'),
    key('used', '2026-09-01T00:00:00Z'),
    key('made-in-window', '2026-10-15T00:00:00Z'),
    key('revoked', '2026-09-01T00:00:00Z', { revoked_at: '2026-09-20T00:00:00Z' }),
    key('expired', '2026-09-01T00:00:00Z', { expires_at: '2026-10-20T00:00:00Z' }),
    key('expires-later', '2026-09-03T00:00:00Z', { expires_at: '2027-01-01T00:00:00Z' }),
  ];

  const idle = idleKeys(keys, [point({ actor_id: 'used' })], start, now);

  expect(idle.map((row) => row.id)).toEqual(['older-idle', 'newer-idle', 'expires-later']);
});
