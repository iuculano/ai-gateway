import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { DatabaseQuery, DatabaseResponse } from '@repo/test-helpers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { GetModelResponse } from '../../src/api/models/models.schemas';
import type { ModelRoutingOptions } from '../../src/api/models/models.services';
import { database, forCaller, installModuleMocks, modelRow, resetDoubles, rows } from './doubles';
import { expectErr, expectOk } from './result';

await installModuleMocks();
const service = forCaller((await import('../../src/api/models/models.services')).default);
let random: ReturnType<typeof spyOn<typeof Math, 'random'>>;

const dialect = new PgDialect();

// Prices for the cost routing test, by model name. Everything else gets the
// modelRow defaults.
const prices: Record<string, { cost_input: number | null; cost_output: number | null }> = {
  'cost-unknown': { cost_input: null, cost_output: 1 },
  'cost-expensive': { cost_input: 0.1, cost_output: 10 },
  'cost-cheap': { cost_input: 1, cost_output: 1 },
  'cost-free': { cost_input: 0, cost_output: 0 },
  'cost-tie': { cost_input: 0.5, cost_output: 1.5 },
};

/** Answers a catalog lookup with a row named after the model it asked for, or none when the name says missing. */
function catalog(query: DatabaseQuery): DatabaseResponse {
  const where = query.calls.find((call) => call.method === 'where')?.args[0];
  const [provider, name] = dialect.sqlToQuery(where as never).params as string[];

  if (!name || name.includes('missing')) {
    return rows();
  }

  return rows(modelRow({ provider, name, ...prices[name] }));
}

function slugs(models: GetModelResponse[]): string[] {
  return models.map((model) => `${model.provider}/${model.name}`);
}

beforeEach(() => {
  resetDoubles();
  database.defaultResponse('select', 'models', catalog);
  random = spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => random.mockRestore());

// Each test uses distinct slugs because successful lookups are cached.
test('default ordering trims slugs and skips missing models without reordering', async () => {
  const ordered = await service.validateAndOrderModels(
    ' openai/default-a , openai/missing,, openai/default-b ',
    'chat',
    {},
  );
  expect(slugs(expectOk(ordered))).toEqual(['openai/default-a', 'openai/default-b']);
});

test('random routing shuffles valid models and skips missing ones', async () => {
  const shuffled = await service.validateAndOrderModels(
    'openai/random-a,openai/random-missing,openai/random-b',
    'chat',
    { strategy: 'random' },
  );
  expect(slugs(expectOk(shuffled))).toEqual(['openai/random-b', 'openai/random-a']);

  random.mockReturnValue(0.999);
  const unshuffled = await service.validateAndOrderModels('openai/random-a,openai/random-b', 'chat', {
    strategy: 'random',
  });
  expect(slugs(expectOk(unshuffled))).toEqual(['openai/random-a', 'openai/random-b']);
});

test('weighted routing rerolls remaining relative weights without duplicates', async () => {
  random.mockReturnValueOnce(0.69).mockReturnValueOnce(0.7);
  const ordered = await service.validateAndOrderModels(
    'openai/weighted-a,openai/weighted-b,openai/weighted-c',
    'chat',
    { strategy: 'weighted', weights: '70, 20, 10' },
  );
  expect(slugs(expectOk(ordered))).toEqual(['openai/weighted-a', 'openai/weighted-c', 'openai/weighted-b']);
});

test('a weighted roll on a boundary selects the next candidate', async () => {
  random.mockReturnValueOnce(0.5);
  const ordered = await service.validateAndOrderModels('openai/boundary-a,openai/boundary-b', 'chat', {
    strategy: 'weighted',
    weights: '1,1',
  });
  expect(slugs(expectOk(ordered))).toEqual(['openai/boundary-b', 'openai/boundary-a']);
});

test('weighted routing skips a missing selection and continues', async () => {
  const ordered = await service.validateAndOrderModels('openai/weighted-missing,openai/weighted-valid', 'chat', {
    strategy: 'weighted',
    weights: '70,30',
  });
  expect(slugs(expectOk(ordered))).toEqual(['openai/weighted-valid']);
});

test.each([undefined, '', '1', '0,1', '-1,2', 'NaN,2', 'Infinity,1', '1,', '1,2,3'])(
  'invalid weights reject before database work: %s',
  async (weights) => {
    expect(
      expectErr(
        await service.validateAndOrderModels('openai/a,openai/b', 'chat', {
          strategy: 'weighted',
          weights,
        }),
      ),
    ).toMatchObject({ code: 'MODEL_INVALID_ROUTING' });
    expect(database.queries).toHaveLength(0);
  },
);

test('cost ordering uses both prices, preserves ties, and places unknown prices last', async () => {
  const ordered = await service.validateAndOrderModels(
    'openai/cost-unknown,openai/cost-expensive,openai/cost-missing,openai/cost-cheap,openai/cost-free,openai/cost-tie',
    'chat',
    { strategy: 'cost' },
  );
  expect(slugs(expectOk(ordered))).toEqual([
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
    expect(slugs(expectOk(await service.validateAndOrderModels(slug, 'chat', options)))).toEqual([slug]);
    expect(expectErr(await service.validateAndOrderModels(`${slug}-missing`, 'chat', options))).toEqual({
      code: 'MODEL_NOT_FOUND',
      model: `${slug}-missing`,
    });
  },
);
