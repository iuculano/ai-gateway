import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { err, ok } from 'neverthrow';
import type { ModelRoutingOptions } from '../../src/api/models/models.services';
import { forCaller, installModuleMocks, modelRow, resetDoubles } from './doubles';

await installModuleMocks();
const ModelsService = (await import('../../src/api/models/models.services')).default;
const Schemas = (await import('../../src/api/models/models.schemas')).default;
const service = forCaller(ModelsService);
const options = (extra: ModelRoutingOptions = {}): ModelRoutingOptions => extra;
let lookup: ReturnType<typeof spyOn<typeof ModelsService, 'getModelBySlug'>>;
let random: ReturnType<typeof spyOn<typeof Math, 'random'>>;

beforeEach(() => {
  resetDoubles();
  random = spyOn(Math, 'random').mockReturnValue(0);
  // Mock the lookup boundary so the model cache cannot leak between tests.
  lookup = spyOn(ModelsService, 'getModelBySlug').mockImplementation(async (slug) => {
    if (slug === 'missing' || !slug) return err({ code: 'MODEL_NOT_FOUND', slug });
    return ok(Schemas.getModel.response.parse(modelRow()));
  });
});
afterEach(() => {
  lookup.mockRestore();
  random.mockRestore();
});

test('omitted strategy trims slugs, skips missing models, and preserves order', async () => {
  expect(await service.validateAndOrderModels(' openai/a , missing,, openrouter/anthropic/b ', options())).toEqual([
    'openai/a',
    'openrouter/anthropic/b',
  ]);
  expect(lookup.mock.calls.map(([slug]) => slug)).toEqual(['openai/a', 'missing', '', 'openrouter/anthropic/b']);
  expect(random).not.toHaveBeenCalled();
});

test('random routing shuffles the full list', async () => {
  const config = options({ strategy: 'random' });
  expect(await service.validateAndOrderModels('openai/a,openai/b,openai/c', config)).toEqual([
    'openai/b',
    'openai/c',
    'openai/a',
  ]);
  random.mockReturnValue(0.999);
  expect(await service.validateAndOrderModels('openai/a,openai/b,openai/c', config)).toEqual([
    'openai/a',
    'openai/b',
    'openai/c',
  ]);
});

test('random routing skips missing models after shuffling', async () => {
  expect(
    await service.validateAndOrderModels(
      'openai/a,missing,openai/c',
      options({
        strategy: 'random',
      }),
    ),
  ).toEqual(['openai/c', 'openai/a']);
});

test('weighted routing uses remaining relative weights without selecting a model twice', async () => {
  random.mockReturnValueOnce(0.69).mockReturnValueOnce(0.7);
  expect(
    await service.validateAndOrderModels(
      'openai/a,openai/b,openai/c',
      options({
        strategy: 'weighted',
        weights: '70, 20, 10',
      }),
    ),
  ).toEqual(['openai/a', 'openai/c', 'openai/b']);
  expect(lookup.mock.calls.map(([slug]) => slug)).toEqual(['openai/a', 'openai/c', 'openai/b']);
});

test('a weighted roll exactly on a boundary selects the next candidate', async () => {
  random.mockReturnValueOnce(0.5);
  expect(
    await service.validateAndOrderModels(
      'openai/a,openai/b',
      options({
        strategy: 'weighted',
        weights: '1,1',
      }),
    ),
  ).toEqual(['openai/b', 'openai/a']);
});

test('weighted routing removes missing models from future draws', async () => {
  expect(
    await service.validateAndOrderModels(
      'missing,openai/b,openai/c',
      options({
        strategy: 'weighted',
        weights: '70,20,10',
      }),
    ),
  ).toEqual(['openai/b', 'openai/c']);
  expect(lookup.mock.calls.map(([slug]) => slug)).toEqual(['missing', 'openai/b', 'openai/c']);
});

test.each([undefined, '', '1', '0,1', '-1,2', 'NaN,2', 'Infinity,1', '1,', '1,2,3'])(
  'invalid weights reject before model lookups: %s',
  async (weights) => {
    expect(
      await service.validateAndOrderModels(
        'openai/a,openai/b',
        options({
          strategy: 'weighted',
          weights: weights,
        }),
      ),
    ).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  },
);

test('cost routing uses both prices, keeps free models first, and unknown prices last', async () => {
  const prices = [
    { cost_input: null, cost_output: 1 },
    { cost_input: 0.1, cost_output: 10 },
    { cost_input: 1, cost_output: 1 },
    { cost_input: 0, cost_output: 0 },
  ];
  for (const price of prices) lookup.mockResolvedValueOnce(ok(Schemas.getModel.response.parse(modelRow(price))));
  expect(
    await service.validateAndOrderModels(
      'openai/unknown,openai/expensive,openai/cheap,openai/free',
      options({
        strategy: 'cost',
      }),
    ),
  ).toEqual(['openai/free', 'openai/cheap', 'openai/expensive', 'openai/unknown']);
});

test('cost routing preserves ties and skips missing models', async () => {
  expect(
    await service.validateAndOrderModels(
      'openai/a,missing,openai/b',
      options({
        strategy: 'cost',
      }),
    ),
  ).toEqual(['openai/a', 'openai/b']);
});

test.each([undefined, 'random', 'weighted', 'cost'] as const)('one valid candidate works with %s', async (strategy) => {
  expect(
    await service.validateAndOrderModels(
      'openai/a',
      options({
        strategy: strategy,
        ...(strategy === 'weighted' ? { weights: '1' } : {}),
      }),
    ),
  ).toEqual(['openai/a']);
});

test.each([undefined, 'random', 'weighted', 'cost'] as const)('no valid candidates with %s', async (strategy) => {
  const result = await service.validateAndOrderModels(
    'missing',
    options({
      strategy: strategy,
      ...(strategy === 'weighted' ? { weights: '1' } : {}),
    }),
  );
  expect(result).toBeUndefined();
});

test('database failures propagate rather than masquerading as missing models', async () => {
  lookup.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(
    service.validateAndOrderModels(
      'openai/a',
      options({
        strategy: 'cost',
      }),
    ),
  ).rejects.toThrow('database unavailable');
});
