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

const USAGE: ModelUsage = {
  provider: 'openai',
  model: 'gpt-big',
  requests: 10,
  gatewayCacheHits: 2,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cost: 20,
};

function point(fields: Partial<SeriesPoint>): SeriesPoint {
  return {
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
  } as SeriesPoint;
}

/**
 * A catalog entry priced per million tokens.
 */
function price(
  name: string,
  cost_input: number | null,
  cost_output: number | null,
  type: ModelPrice['type'] = 'chat',
): ModelPrice {
  return {
    provider: 'openai',
    name: name,
    type: type,
    cost_input: cost_input,
    cost_output: cost_output,
  };
}

function key(id: string, created_at: string, fields: Partial<KeySummary> = {}): KeySummary {
  return {
    id: id,
    name: id,
    created_at: created_at,
    revoked_at: null,
    expires_at: null,
    total_requests: 0,
    ...fields,
  };
}

test('sums actors down to one row per model, biggest spend first', () => {
  const points = [
    point({ actor_id: 'key-a', cost_total: 1, requests: 2 }),
    point({ actor_id: 'key-b', cost_total: 2, requests: 3 }),
    point({ model: 'gpt-huge', cost_total: 9, requests: 1 }),
  ];

  const rows = usageByModel(points);

  expect(rows.map((row) => [row.model, row.cost, row.requests])).toEqual([
    ['gpt-huge', 9, 1],
    ['gpt-big', 3, 5],
  ]);
});

test('reprices tokens at per-million prices, and refuses an unpriced model', () => {
  expect(costAt(USAGE, price('gpt-small', 1, 2))).toBe(2);
  expect(costAt(USAGE, price('gpt-free', null, null))).toBeNull();
});

test('picks the cheapest chat model that saves money', () => {
  const cheapest = price('gpt-small', 1, 2);
  const candidates = [
    price('gpt-big', 0, 0), // the model itself
    price('gpt-mid', 4, 8),
    cheapest,
    price('embed', 0, 0, 'embedding'),
    price('gpt-unpriced', null, null),
  ];

  expect(cheapestSwitch(USAGE, candidates)).toEqual({ price: cheapest, cost: 2 });
});

test('offers no switch when every alternative costs more', () => {
  expect(cheapestSwitch(USAGE, [price('gpt-pricier', 100, 100)])).toBeNull();
});

test('values cache hits at the average cost of the requests that were answered', () => {
  expect(cacheSaved(USAGE)).toBe(5);
});

test('cannot value cache hits when nothing was answered by a provider', () => {
  const allCached = { ...USAGE, requests: 2, gatewayCacheHits: 2, cost: 0 };

  expect(cacheSaved(allCached)).toBeNull();
});

test('ranks keys by spend, against all callers and the window before', () => {
  const current = [
    point({ actor_id: 'key-a', model: 'gpt-big', cost_total: 6, requests: 1 }),
    point({ actor_id: 'key-a', model: 'gpt-small', cost_total: 2, requests: 4 }),
    point({ actor_id: 'key-b', cost_total: 1, requests: 1 }),
    point({ actor_type: 'user', actor_id: 'person', cost_total: 1, requests: 1 }),
  ];
  const previous = [point({ actor_id: 'key-a', cost_total: 4 })];

  const ranked = rankKeys(current, previous);

  // The user is not a key, but their spend still counts towards the shares.
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
  const traffic = [point({ actor_id: 'used' })];

  const idle = idleKeys(keys, traffic, start, now);

  expect(idle.map((row) => row.id)).toEqual(['older-idle', 'newer-idle', 'expires-later']);
});
