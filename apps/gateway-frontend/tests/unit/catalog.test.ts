import { expect, test } from 'bun:test';
import type { CatalogModel, CatalogProvider } from '../../src/lib/api/types';
import {
  byInputPrice,
  capabilities,
  largestContext,
  matchingOptions,
  modelOptions,
  modelStatus,
  oldestSync,
  priceRange,
  searchCatalog,
  syncState,
} from '../../src/lib/data/catalog';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function model(id: string, fields: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: id,
    status: 'available',
    delisted_at: null,
    cost_input: null,
    context_limit: null,
    ...fields,
  } as CatalogModel;
}

test('a delisted model reads as delisted, whatever the provider last said about it', () => {
  const gone = model('old', { status: 'beta', delisted_at: '2026-09-01T00:00:00.000Z' });

  expect(modelStatus(gone)).toBe('delisted');
  expect(modelStatus(model('new', { status: 'beta' }))).toBe('beta');
});

test('models are listed cheapest first, with the unpriced ones last', () => {
  const models = [
    model('image', { cost_input: null }),
    model('large', { cost_input: 15 }),
    model('free', { cost_input: 0 }),
    model('embedding', { cost_input: null }),
    model('small', { cost_input: 0.15 }),
  ];

  const order = byInputPrice(models).map((entry) => entry.id);

  expect(order).toEqual(['free', 'small', 'large', 'image', 'embedding']);
});

test('a model is labelled with the capabilities it has', () => {
  const capable = model('capable', { tool_call: true, attachment: true, structured_output: true });

  expect(capabilities(capable)).toEqual(['Tools', 'Vision', 'JSON']);
  expect(capabilities(model('plain'))).toEqual([]);
});

test('a price range runs from the cheapest to the dearest, leaving out the unpriced', () => {
  expect(priceRange([15, null, 0.15, 3])).toBe('$0.15 – $15.00');
  expect(priceRange([3, null, 3])).toBe('$3.00');
  expect(priceRange([null, null])).toBe('Unpriced');
});

test('the largest context window is found among the models that state one', () => {
  const models = [model('a', { context_limit: 128_000 }), model('b'), model('c', { context_limit: 1_000_000 })];

  expect(largestContext(models)).toBe(1_000_000);
  expect(largestContext([model('b')])).toBeNull();
});

test('a provider goes stale once it has missed three hourly syncs', () => {
  const justInside = new Date(NOW - 3 * HOUR_MS).toISOString();
  const justOutside = new Date(NOW - 3 * HOUR_MS - 1).toISOString();

  expect(syncState(justInside, NOW)).toBe('synced');
  expect(syncState(justOutside, NOW)).toBe('stale');
  expect(syncState(null, NOW)).toBe('never');
});

// The models page

test('a search that names a provider keeps all its models, and otherwise only the models that match', () => {
  const providers = [
    {
      id: 'openai',
      models: [
        { name: 'gpt-5', display_name: 'GPT-5' },
        { name: 'o4', display_name: null },
      ],
    },
    { id: 'anthropic', models: [{ name: 'claude-opus', display_name: 'Claude Opus' }] },
    { id: 'google', models: [{ name: 'gemini', display_name: 'Gemini with GPT-style tools' }] },
  ] as unknown as CatalogProvider[];

  const byProvider = searchCatalog(providers, ' OpenAI ');
  const byModel = searchCatalog(providers, 'gpt');

  expect(byProvider.map((provider) => [provider.id, provider.models.length])).toEqual([['openai', 2]]);
  expect(byModel.map((provider) => [provider.id, provider.models.map((model) => model.name)])).toEqual([
    ['openai', ['gpt-5']],
    ['google', ['gemini']],
  ]);
});

test('the catalog is as stale as the provider that has gone longest without a sync', () => {
  const providers = [
    { id: 'a', synced_at: '2026-09-10T10:00:00.000Z' },
    { id: 'b', synced_at: null },
    { id: 'c', synced_at: '2026-09-10T04:00:00.000Z' },
  ] as unknown as CatalogProvider[];

  expect(oldestSync(providers)).toBe('2026-09-10T04:00:00.000Z');
  expect(oldestSync([{ id: 'b', synced_at: null }] as unknown as CatalogProvider[])).toBeNull();
});

// The model picker

test('the picker offers the live models of one endpoint, under their provider', () => {
  const providers = [
    {
      id: 'openai',
      models: [
        { name: 'gpt-5', type: 'chat', delisted_at: null, redirect_to: null, cost_input: 1.25, context_limit: 400_000 },
        { name: 'gpt-old', type: 'chat', delisted_at: '2026-01-01T00:00:00.000Z', redirect_to: null },
        { name: 'gpt-latest', type: 'chat', delisted_at: null, redirect_to: 'gpt-5' },
        { name: 'embed-3', type: 'embedding', delisted_at: null, redirect_to: null },
      ],
    },
  ] as unknown as CatalogProvider[];

  const options = modelOptions(providers, 'chat');

  expect(options).toEqual([
    { slug: 'openai/gpt-5', provider: 'openai', name: 'gpt-5', cost_input: 1.25, context_limit: 400_000 },
  ]);
});

test('what is typed narrows the suggestions whatever its case, cheapest first and unpriced last', () => {
  const options = [
    { slug: 'openai/gpt-5', cost_input: 1.25 },
    { slug: 'azure/gpt-5-image', cost_input: null },
    { slug: 'openai/gpt-5-mini', cost_input: 0.25 },
    { slug: 'anthropic/claude', cost_input: 3 },
  ].map((option) => ({ provider: '', name: '', context_limit: null, ...option }));

  const slugs = matchingOptions(options, ' GPT-5 ').map((option) => option.slug);

  expect(slugs).toEqual(['openai/gpt-5-mini', 'openai/gpt-5', 'azure/gpt-5-image']);
});

test('the suggestions stop at fifty', () => {
  const options = Array.from({ length: 80 }, (_, index) => ({
    slug: `provider/model-${index}`,
    provider: 'provider',
    name: `model-${index}`,
    cost_input: index,
    context_limit: null,
  }));

  expect(matchingOptions(options, '')).toHaveLength(50);
});
