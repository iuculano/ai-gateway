import { expect, test } from 'bun:test';
import { spendDrivers, spendEffects } from '../../src/lib/data/spend-drivers';

type Point = { provider: string; model: string; requests: number; cost_total: number };

function point(model: string, requests: number, cost_total: number, provider = 'openai'): Point {
  return {
    provider: provider,
    model: model,
    requests: requests,
    cost_total: cost_total,
  };
}

/**
 * How much of the change in spend came from volume, model mix and unit cost, in
 * that order.
 */
function effects(current: Point[], previous: Point[]): number[] {
  const result = spendDrivers(current, previous);

  if (!result.steps) {
    throw new Error('Expected comparable periods');
  }

  const volume = result.steps.afterVolume - result.previousSpend;
  const mix = result.steps.afterMix - result.steps.afterVolume;
  const unitCost = result.currentSpend - result.steps.afterMix;

  return [volume, mix, unitCost];
}

test('isolates volume, model mix and unit cost when each changes alone', () => {
  const previous = [point('cheap', 50, 50), point('expensive', 50, 150)];

  const doubledVolume = effects([point('cheap', 100, 100), point('expensive', 100, 300)], previous);
  const shiftedMix = effects([point('cheap', 25, 25), point('expensive', 75, 225)], previous);
  const pricierCheap = effects([point('cheap', 50, 100), point('expensive', 50, 150)], previous);

  expect(doubledVolume).toEqual([200, 0, 0]);
  expect(shiftedMix).toEqual([0, 50, 0]);
  expect(pricierCheap).toEqual([0, 0, 50]);
});

test('mixed changes reconcile, keeping providers separate for identically named models', () => {
  const previous = [point('same', 60, 30), point('same', 40, 80, 'azure')];
  const current = [point('same', 50, 40), point('same', 150, 240, 'azure')];

  const [volume, mix, unitCost] = effects(current, previous);

  expect(volume).toBeCloseTo(110);
  expect(mix).toBeCloseTo(105);
  expect(unitCost).toBeCloseTo(-45);

  // The three effects add up to the whole change, 280 against 110.
  expect((volume ?? 0) + (mix ?? 0) + (unitCost ?? 0)).toBeCloseTo(170);
});

test('new and retired models contribute to mix without fabricated unit cost history', () => {
  const previous = [point('retired', 100, 100)];
  const current = [point('new', 100, 300)];

  expect(effects(current, previous)).toEqual([0, 200, 0]);
  expect(spendDrivers(current, previous).includesNewModels).toBe(true);
});

test('no previous traffic leaves attribution unavailable', () => {
  expect(spendDrivers([point('new', 10, 20)], []).steps).toBeNull();
  expect(spendDrivers([], []).steps).toBeNull();
});

test('traffic that stopped is a volume decrease', () => {
  expect(effects([], [point('old', 100, 75)])).toEqual([-75, 0, 0]);
});

test('free requests are a valid baseline and duplicate groups aggregate', () => {
  const previous = [point('a', 30, 0), point('a', 70, 0)];

  expect(effects([point('a', 100, 15)], previous)).toEqual([0, 0, 15]);

  // The inputs are summed without being changed.
  expect(previous).toEqual([point('a', 30, 0), point('a', 70, 0)]);
});

// spendEffects

test('the contributions shown add up to the change in the totals shown', () => {
  // The totals shown are $1.00 and $1.03. Rounded one by one, the three steps
  // would read 0.00, 0.01 and 0.01, which is a cent short of that.
  const attribution = {
    previousSpend: 1.004,
    currentSpend: 1.027,
    includesNewModels: false,
    steps: { afterVolume: 1.008, afterMix: 1.016 },
  };

  const shown = spendEffects(attribution);
  const cents = shown.effects.map((effect) => Math.round((effect.amount ?? 0) * 100));

  expect(shown.decimals).toBe(2);
  expect(shown.effects.map((effect) => effect.label)).toEqual(['Request volume', 'Model mix', 'Cost per request']);
  expect(cents).toEqual([1, 1, 1]);
});

test('a workload under a cent is shown to six places', () => {
  const attribution = {
    previousSpend: 0.000_4,
    currentSpend: 0.000_9,
    includesNewModels: false,
    steps: { afterVolume: 0.000_6, afterMix: 0.000_7 },
  };

  const shown = spendEffects(attribution);

  expect(shown.decimals).toBe(6);
  expect(shown.effects[0]?.amount).toBeCloseTo(0.000_2, 10);
});

test('with no traffic before, no contribution has an amount', () => {
  const shown = spendEffects({ previousSpend: 0, currentSpend: 5, includesNewModels: true, steps: null });

  expect(shown.effects.map((effect) => effect.amount)).toEqual([null, null, null]);
});
