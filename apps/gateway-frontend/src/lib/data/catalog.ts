import type { CatalogModel, CatalogProvider } from '#lib/api/types.ts';
import { fmtPricePerMillion } from '#lib/data/format.ts';

// A provider is stale once it has missed three of its hourly syncs.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

// How many suggestions the model picker lists at once.
const MOST_SUGGESTIONS = 50;

export type CatalogStatus = CatalogModel['status'] | 'delisted';
export type SyncState = 'never' | 'stale' | 'synced';

/**
 * What a model's status column shows.
 */
export function modelStatus(model: CatalogModel): CatalogStatus {
  // What the provider says about a model and whether the model still appears
  // at all are separate facts. There is one column, and a model that has left
  // the catalog is the more urgent of the two.
  return model.delisted_at !== null ? 'delisted' : model.status;
}

/**
 * The models with the cheapest input first and the unpriced ones last.
 */
export function byInputPrice(models: CatalogModel[]): CatalogModel[] {
  // Compared case by case and not by subtracting, because a missing price
  // counted as zero would put every image model above the ones people shop
  // between, and counted as infinity would make two of them compare as NaN.
  return models.toSorted((a, b) => {
    if (a.cost_input === b.cost_input) {
      return 0;
    }

    if (a.cost_input === null) {
      return 1;
    }

    if (b.cost_input === null) {
      return -1;
    }

    return a.cost_input - b.cost_input;
  });
}

/**
 * A model's capability flags, as short labels.
 */
export function capabilities(model: CatalogModel): string[] {
  const flags: string[] = [];

  if (model.tool_call) {
    flags.push('Tools');
  }

  if (model.reasoning) {
    flags.push('Reasoning');
  }

  if (model.attachment) {
    flags.push('Vision');
  }

  if (model.structured_output) {
    flags.push('JSON');
  }

  return flags;
}

/**
 * The span of one price across a provider's models, such as '$0.15 – $15.00'.
 */
export function priceRange(prices: (number | null)[]): string {
  // An unpriced model is left out and not counted as zero, which would drag
  // every range down to '$0.00' the moment one image model appeared.
  const known = prices.filter((price) => price !== null);

  if (known.length === 0) {
    return 'Unpriced';
  }

  const low = Math.min(...known);
  const high = Math.max(...known);

  return low === high ? fmtPricePerMillion(low) : `${fmtPricePerMillion(low)} – ${fmtPricePerMillion(high)}`;
}

/**
 * The largest context window among the models, or null when none states one.
 */
export function largestContext(models: CatalogModel[]): number | null {
  let largest: number | null = null;

  for (const model of models) {
    if (model.context_limit && model.context_limit > (largest ?? 0)) {
      largest = model.context_limit;
    }
  }

  return largest;
}

/**
 * How fresh a provider's models are.
 */
export function syncState(syncedAt: string | null, now: number): SyncState {
  if (syncedAt === null) {
    return 'never';
  }

  return now - new Date(syncedAt).getTime() > STALE_AFTER_MS ? 'stale' : 'synced';
}

/**
 * The providers narrowed to what a search matches. A provider whose own name
 * matches keeps all of its models, and any other keeps only the models that
 * match. A provider left with no models is dropped.
 */
export function searchCatalog(providers: CatalogProvider[], search: string): CatalogProvider[] {
  const query = search.trim().toLowerCase();
  const matches: CatalogProvider[] = [];

  for (const provider of providers) {
    let models = provider.models;

    if (query && !provider.id.toLowerCase().includes(query)) {
      models = models.filter((model) => {
        const names = `${model.name} ${model.display_name ?? ''}`.toLowerCase();

        return names.includes(query);
      });
    }

    if (models.length > 0) {
      matches.push({ ...provider, models: models });
    }
  }

  return matches;
}

/**
 * When the provider that has gone longest without a sync was last synced, or
 * null when none of them ever has been. It is the figure that says the catalog
 * is going stale.
 */
export function oldestSync(providers: CatalogProvider[]): string | null {
  let oldest: string | null = null;

  for (const provider of providers) {
    if (provider.synced_at !== null && (oldest === null || provider.synced_at < oldest)) {
      oldest = provider.synced_at;
    }
  }

  return oldest;
}

/**
 * A model as the picker suggests it.
 */
export interface ModelOption {
  /**
   * What goes in the field, which is the explicit `provider/name` form.
   */
  slug: string;
  provider: string;
  name: string;
  cost_input: number | null;
  context_limit: number | null;
}

/**
 * The models that can be picked for one kind of endpoint.
 */
export function modelOptions(providers: CatalogProvider[], type: CatalogModel['type']): ModelOption[] {
  const options: ModelOption[] = [];

  for (const provider of providers) {
    for (const model of provider.models) {
      // A redirect is an alias for callers already using an old name, and not
      // something to pick.
      if (model.delisted_at !== null || model.type !== type || model.redirect_to !== null) {
        continue;
      }

      options.push({
        slug: `${provider.id}/${model.name}`,
        provider: provider.id,
        name: model.name,
        cost_input: model.cost_input,
        context_limit: model.context_limit,
      });
    }
  }

  return options;
}

/**
 * The options that match what was typed, cheapest first.
 */
export function matchingOptions(options: ModelOption[], typed: string): ModelOption[] {
  const query = typed.trim().toLowerCase();
  const pool = query ? options.filter((option) => option.slug.toLowerCase().includes(query)) : options;

  // Cheapest first, so that the top of a broad match is the affordable end and
  // not whatever a provider happened to publish first.
  return pool
    .toSorted((a, b) => (a.cost_input ?? Number.MAX_VALUE) - (b.cost_input ?? Number.MAX_VALUE))
    .slice(0, MOST_SUGGESTIONS);
}
