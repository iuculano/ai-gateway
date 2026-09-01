import { logger } from '@repo/core';
import { environment } from '../environment';
import { upsertCatalog } from './catalog-upsert';

/**
 * One model as a specific provider sells it.
 *
 * Everything past `id` is optional because models.dev genuinely omits fields:
 * 425 of its 6839 offerings carry no `cost` block at all, which is the
 * difference between a model that is free and one whose price is unknown. That
 * distinction has to survive into the database rather than collapsing to zero.
 *
 * Prices are US dollars per million tokens.
 */
export interface CatalogOffering {
  id: string;
  name?: string;
  description?: string;
  family?: string;

  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  open_weights?: boolean;

  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  status?: string;

  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
}

interface CatalogProvider {
  id: string;
  name?: string;
  npm?: string;
  env?: string[];
  doc?: string;
  models: Record<string, CatalogOffering>;
}

interface Catalog {
  providers: Record<string, CatalogProvider>;

  /**
   * The canonical half - 353 vendor-keyed model definitions, carrying
   * benchmarks, weights and licences but never a price.
   *
   * Fetched because it arrives in the same body, not ingested. models.dev
   * publishes no link from an offering to its canonical definition, so joining
   * them means matching on the id suffix: that resolves 41 of OpenAI's 47 and
   * 55 of Azure's 84, and is an inference rather than a contract. Not worth
   * depending on until something needs benchmark data.
   */
  models: Record<string, unknown>;
}

/** One provider's offerings, flattened with the provider it came from. */
export interface SelectedOffering {
  provider: string;
  offering: CatalogOffering;
}

/**
 * The ETag models.dev served last, so the next tick can ask for a body only if
 * something actually changed.
 *
 * In memory, which is not where it belongs - it should be a row, so that a
 * restart does not re-download and re-upsert an unchanged catalogue. It moves
 * there when the catalogue tables land. The cost until then is one wasted 4 MB
 * fetch per process start.
 */
let lastEtag: string | undefined;

/**
 * Fetches the catalogue, unless models.dev says it has not changed.
 *
 * @returns
 * The parsed catalogue, or null when the upstream answered 304 and there is
 * nothing to do.
 */
async function fetchCatalog(): Promise<Catalog | null> {
  const response = await fetch(environment.CATALOG_SOURCE_URL, {
    headers: lastEtag ? { 'if-none-match': lastEtag } : {},
    signal: AbortSignal.timeout(environment.CATALOG_FETCH_TIMEOUT_MS),
  });

  if (response.status === 304) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`models.dev answered ${response.status} ${response.statusText}`);
  }

  const catalog = (await response.json()) as Catalog;

  if (!catalog.providers) {
    throw new Error('models.dev returned a body with no `providers` key');
  }

  // Only after a successful parse. Recording it earlier would mean a body that
  // arrived truncated or malformed still suppressed the next fetch, and the
  // catalogue would stay stale until the upstream happened to change again.
  lastEtag = response.headers.get('etag') ?? undefined;

  return catalog;
}

/** Flattens a models.dev snapshot into rows for the catalogue upsert. */
function selectOfferings(catalog: Catalog): SelectedOffering[] {
  return Object.entries(catalog.providers).flatMap(([provider, entry]) =>
    Object.values(entry.models).map((offering) => ({ provider, offering })),
  );
}

/**
 * One pass: fetch if changed, flatten the provider offerings, and upsert.
 *
 * Throws on a failed fetch or an unparseable body. The caller decides what that
 * means - a catalogue that is a few hours stale is not an outage, so a failed
 * tick is logged and the next one simply tries again.
 */
export async function tickModelCatalog(): Promise<void> {
  const catalog = await fetchCatalog();

  if (!catalog) {
    logger.debug('models.dev catalogue is unchanged');
    return;
  }

  const offerings = selectOfferings(catalog);
  const unpriced = offerings.filter((item) => !item.offering.cost).length;
  const summary = await upsertCatalog(offerings);

  logger.info(
    {
      providers: Object.keys(catalog.providers).length,
      offerings: offerings.length,
      unpriced: unpriced,
      written: summary.written,
      delisted: summary.delisted,
      confirmed: summary.confirmed,
    },
    'Synced models.dev catalogue',
  );
}
