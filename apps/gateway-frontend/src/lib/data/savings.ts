import type { SeriesPoint } from '#lib/api/analytics.ts';
import type { ApiKey, CatalogModel } from '#lib/api/types.ts';

/**
 * The catalog fields a what-if needs. Prices are dollars per million tokens.
 */
export type ModelPrice = Pick<CatalogModel, 'provider' | 'name' | 'type' | 'cost_input' | 'cost_output'>;

/**
 * The API key fields the idle check needs.
 */
export type KeySummary = Pick<ApiKey, 'id' | 'name' | 'created_at' | 'revoked_at' | 'expires_at' | 'total_requests'>;

export interface ModelUsage {
  provider: string;
  model: string;
  requests: number;
  gatewayCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface KeySpend {
  id: string;
  cost: number;
  requests: number;

  /**
   * Of everything spent in the window, keys or not.
   */
  share: number;

  /**
   * Spend in the window before, or 0 when the key spent nothing then.
   */
  previous: number;
  topModel: string;

  /**
   * Of this key's own spend.
   */
  topModelShare: number;
}

/**
 * Sums rows grouped by actor as well down to one row per provider and model.
 */
export function usageByModel(points: SeriesPoint[]): ModelUsage[] {
  const rows = new Map<string, ModelUsage>();

  for (const point of points) {
    if (!point.provider || !point.model) {
      continue;
    }

    const key = `${point.provider}/${point.model}`;
    let row = rows.get(key);

    if (!row) {
      row = {
        provider: point.provider,
        model: point.model,
        requests: 0,
        gatewayCacheHits: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      rows.set(key, row);
    }

    row.requests += point.requests;
    row.gatewayCacheHits += point.gateway_cache_hits;
    row.inputTokens += point.input_tokens;
    row.outputTokens += point.output_tokens;
    row.cost += point.cost_total;
  }

  return [...rows.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * What these tokens would cost at another model's list price, or null if it has
 * no price.
 */
export function costAt(usage: ModelUsage, price: ModelPrice): number | null {
  if (price.cost_input === null || price.cost_output === null) {
    return null;
  }

  // Token counts already leave out gateway cache hits, which cost nothing on
  // any model. No prompt caching is assumed on the new model, so this can
  // overstate what it would cost.
  return (usage.inputTokens * price.cost_input + usage.outputTokens * price.cost_output) / 1_000_000;
}

/**
 * The cheapest chat model for this usage among the candidates, if any saves
 * money.
 */
export function cheapestSwitch(
  usage: ModelUsage,
  candidates: ModelPrice[],
): { price: ModelPrice; cost: number } | null {
  let best: { price: ModelPrice; cost: number } | null = null;

  for (const price of candidates) {
    // Embedding and decision models cannot stand in for a chat model.
    const isSameModel = price.provider === usage.provider && price.name === usage.model;
    if (price.type !== 'chat' || isSameModel) {
      continue;
    }

    const cost = costAt(usage, price);
    if (cost !== null && cost < usage.cost && (!best || cost < best.cost)) {
      best = { price: price, cost: cost };
    }
  }

  return best;
}

/**
 * Roughly what the gateway's cache saved on a model, or null when nothing was
 * answered to average over.
 */
export function cacheSaved(usage: ModelUsage): number | null {
  const answered = usage.requests - usage.gatewayCacheHits;
  if (answered <= 0) {
    return null;
  }

  // Each hit is valued at what an answered request cost on average.
  return (usage.gatewayCacheHits * usage.cost) / answered;
}

/**
 * API keys by spend, from rows grouped by actor, provider and model.
 *
 * @param points
 * This window's rows, all callers.
 *
 * @param previousPoints
 * The window before, grouped by actor.
 */
export function rankKeys(points: SeriesPoint[], previousPoints: SeriesPoint[]): KeySpend[] {
  let total = 0;
  const keys = new Map<string, { cost: number; requests: number; models: Map<string, number> }>();

  for (const point of points) {
    // Every caller counts towards the total, so a key's share is of all spend.
    total += point.cost_total;

    if (point.actor_type !== 'api_key' || !point.actor_id) {
      continue;
    }

    let key = keys.get(point.actor_id);

    if (!key) {
      key = { cost: 0, requests: 0, models: new Map() };
      keys.set(point.actor_id, key);
    }

    const model = `${point.provider}/${point.model}`;

    key.cost += point.cost_total;
    key.requests += point.requests;
    key.models.set(model, (key.models.get(model) ?? 0) + point.cost_total);
  }

  const previous = new Map<string, number>();

  for (const point of previousPoints) {
    if (point.actor_id) {
      previous.set(point.actor_id, point.cost_total);
    }
  }

  const ranked: KeySpend[] = [];

  for (const [id, key] of keys) {
    // The model this key spent the most on.
    const [topModel, topCost] = [...key.models].sort((a, b) => b[1] - a[1])[0];

    ranked.push({
      id: id,
      cost: key.cost,
      requests: key.requests,
      share: total > 0 ? key.cost / total : 0,
      previous: previous.get(id) ?? 0,
      topModel: topModel,
      topModelShare: key.cost > 0 ? topCost / key.cost : 0,
    });
  }

  return ranked.sort((a, b) => b.cost - a.cost);
}

/**
 * Live keys with no traffic in the window.
 *
 * @param keys
 * Every key in the organization.
 *
 * @param points
 * This window's rows, grouped by actor among other things.
 *
 * @param start
 * When the window began.
 *
 * @param now
 * The moment a key's expiry is judged against.
 */
export function idleKeys(keys: KeySummary[], points: SeriesPoint[], start: Date, now: Date): KeySummary[] {
  const used = new Set(points.map((point) => point.actor_id));
  const idle: KeySummary[] = [];

  for (const key of keys) {
    const isLive = !key.revoked_at && (!key.expires_at || new Date(key.expires_at) > now);

    // A key made during the window has not had the whole window to be used.
    const predatesWindow = new Date(key.created_at) < start;

    if (isLive && predatesWindow && !used.has(key.id)) {
      idle.push(key);
    }
  }

  return idle.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
