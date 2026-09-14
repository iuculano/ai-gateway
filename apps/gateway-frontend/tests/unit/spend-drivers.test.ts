import { expect, test } from 'bun:test';
import { spendDrivers } from '../../src/lib/data/spend-drivers';

const point = (model: string, requests: number, cost_total: number, provider = 'openai') => ({
  provider,
  model,
  requests,
  cost_total,
});
function effects(current: ReturnType<typeof point>[], previous: ReturnType<typeof point>[]) {
  const result = spendDrivers(current, previous);
  if (!result.steps) throw new Error('Expected comparable periods');
  return [
    result.steps.afterVolume - result.previousSpend,
    result.steps.afterMix - result.steps.afterVolume,
    result.currentSpend - result.steps.afterMix,
  ];
}

test('isolates volume, model mix and unit cost when each changes alone', () => {
  const previous = [point('cheap', 50, 50), point('expensive', 50, 150)];
  expect(effects([point('cheap', 100, 100), point('expensive', 100, 300)], previous)).toEqual([200, 0, 0]);
  expect(effects([point('cheap', 25, 25), point('expensive', 75, 225)], previous)).toEqual([0, 50, 0]);
  expect(effects([point('cheap', 50, 100), point('expensive', 50, 150)], previous)).toEqual([0, 0, 50]);
});

test('mixed changes reconcile, keeping providers separate for identically named models', () => {
  const previous = [point('same', 60, 30), point('same', 40, 80, 'azure')];
  const current = [point('same', 50, 40), point('same', 150, 240, 'azure')];
  const result = effects(current, previous);
  expect(result[0]).toBeCloseTo(110);
  expect(result[1]).toBeCloseTo(105);
  expect(result[2]).toBeCloseTo(-45);
  expect(result.reduce((sum, value) => sum + value, 0)).toBeCloseTo(170);
});

test('new and retired models contribute to mix without fabricated unit cost history', () => {
  const previous = [point('retired', 100, 100)];
  const current = [point('new', 100, 300)];
  expect(effects(current, previous)).toEqual([0, 200, 0]);
  expect(spendDrivers(current, previous).includesNewModels).toBe(true);
});

test('no previous traffic leaves attribution unavailable, while stopped traffic is a volume decrease', () => {
  expect(spendDrivers([point('new', 10, 20)], []).steps).toBeNull();
  expect(spendDrivers([], []).steps).toBeNull();
  expect(effects([], [point('old', 100, 75)])).toEqual([-75, 0, 0]);
});

test('free requests are a valid baseline and duplicate groups aggregate without mutating inputs', () => {
  const previous = [point('a', 30, 0), point('a', 70, 0)];
  expect(effects([point('a', 100, 15)], previous)).toEqual([0, 0, 15]);
  expect(previous).toEqual([point('a', 30, 0), point('a', 70, 0)]);
});
