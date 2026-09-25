import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { ModelRoutingOptions } from '../../src/api/models/models.services';
import { database, forCaller, installModuleMocks, modelRow, resetDoubles, rows } from './doubles';

await installModuleMocks();
const service = forCaller((await import('../../src/api/models/models.services')).default);
let random: ReturnType<typeof spyOn<typeof Math, 'random'>>;

beforeEach(() => {
  resetDoubles();
  random = spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => random.mockRestore());

// Each test uses distinct slugs because successful lookups are cached.
test('default ordering trims slugs and skips missing models without reordering', async () => {
  database.respondTo('select', 'models', rows(modelRow()), rows(), rows(modelRow()));
  expect(await service.validateAndOrderModels(' openai/default-a , openai/missing,, openai/default-b ', {})).toEqual([
    'openai/default-a',
    'openai/default-b',
  ]);
});

test('random routing shuffles valid models and skips missing ones', async () => {
  database.respondTo('select', 'models', rows(), rows(modelRow()), rows(modelRow()));
  expect(
    await service.validateAndOrderModels('openai/random-a,openai/random-missing,openai/random-b', {
      strategy: 'random',
    }),
  ).toEqual(['openai/random-b', 'openai/random-a']);

  random.mockReturnValue(0.999);
  expect(
    await service.validateAndOrderModels('openai/random-a,openai/random-b', {
      strategy: 'random',
    }),
  ).toEqual(['openai/random-a', 'openai/random-b']);
});

test('weighted routing rerolls remaining relative weights without duplicates', async () => {
  random.mockReturnValueOnce(0.69).mockReturnValueOnce(0.7);
  database.defaultResponse('select', 'models', rows(modelRow()));
  expect(
    await service.validateAndOrderModels('openai/weighted-a,openai/weighted-b,openai/weighted-c', {
      strategy: 'weighted',
      weights: '70, 20, 10',
    }),
  ).toEqual(['openai/weighted-a', 'openai/weighted-c', 'openai/weighted-b']);
});

test('a weighted roll on a boundary selects the next candidate', async () => {
  random.mockReturnValueOnce(0.5);
  database.defaultResponse('select', 'models', rows(modelRow()));
  expect(
    await service.validateAndOrderModels('openai/boundary-a,openai/boundary-b', {
      strategy: 'weighted',
      weights: '1,1',
    }),
  ).toEqual(['openai/boundary-b', 'openai/boundary-a']);
});

test('weighted routing skips a missing selection and continues', async () => {
  database.respondTo('select', 'models', rows(), rows(modelRow()));
  expect(
    await service.validateAndOrderModels('openai/weighted-missing,openai/weighted-valid', {
      strategy: 'weighted',
      weights: '70,30',
    }),
  ).toEqual(['openai/weighted-valid']);
});

test.each([undefined, '', '1', '0,1', '-1,2', 'NaN,2', 'Infinity,1', '1,', '1,2,3'])(
  'invalid weights reject before database work: %s',
  async (weights) => {
    expect(
      await service.validateAndOrderModels('openai/a,openai/b', {
        strategy: 'weighted',
        weights,
      }),
    ).toBeUndefined();
    expect(database.queries).toHaveLength(0);
  },
);

test('cost ordering uses both prices, preserves ties, and places unknown prices last', async () => {
  database.respondTo(
    'select',
    'models',
    rows(modelRow({ cost_input: null, cost_output: 1 })),
    rows(modelRow({ cost_input: 0.1, cost_output: 10 })),
    rows(),
    rows(modelRow({ cost_input: 1, cost_output: 1 })),
    rows(modelRow({ cost_input: 0, cost_output: 0 })),
    rows(modelRow({ cost_input: 0.5, cost_output: 1.5 })),
  );
  expect(
    await service.validateAndOrderModels(
      'openai/cost-unknown,openai/cost-expensive,openai/cost-missing,openai/cost-cheap,openai/cost-free,openai/cost-tie',
      { strategy: 'cost' },
    ),
  ).toEqual([
    'openai/cost-free',
    'openai/cost-cheap',
    'openai/cost-tie',
    'openai/cost-expensive',
    'openai/cost-unknown',
  ]);
});

test.each([undefined, 'random', 'weighted', 'cost'] as const)(
  'single valid and missing candidates with strategy %s',
  async (strategy) => {
    const options: ModelRoutingOptions = {
      strategy,
      ...(strategy === 'weighted' ? { weights: '1' } : {}),
    };
    const slug = `openai/single-${strategy ?? 'default'}`;
    database.respondTo('select', 'models', rows(modelRow()), rows());
    expect(await service.validateAndOrderModels(slug, options)).toEqual([slug]);
    expect(await service.validateAndOrderModels(`${slug}-missing`, options)).toBeUndefined();
  },
);
