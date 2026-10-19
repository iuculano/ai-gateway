import { logger } from '@repo/core';
import type { ModelType } from '@repo/drizzle/schemas';
import { environment } from '../environment';
import { CATALOG_OVERLAY } from './catalog-overlay';
import { deleteExcludedModels, upsertCatalog } from './catalog-upsert';

// Overlay providers are always kept, even when they aren't whitelisted.
const keptProviders = [
  ...new Set([...environment.CATALOG_PROVIDER_WHITELIST, ...CATALOG_OVERLAY.map((item) => item.provider)]),
];
const providerWhitelist = new Set(environment.CATALOG_PROVIDER_WHITELIST);

/**
 * One model as a specific provider sells it.
 *
 * models.dev often leaves fields out, so everything past `id` is optional. A
 * missing price means unknown, not free.
 *
 * Prices are US dollars per million tokens.
 */
export interface CatalogOffering {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  type?: string;

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
}

/** One offering, with the provider and type it's sold under. */
export interface SelectedOffering {
  provider: string;
  type: ModelType;
  offering: CatalogOffering;
  redirect_to?: string;
}

/**
 * The last ETag from models.dev, so an unchanged catalog comes back as a 304.
 *
 * Kept in memory, so a restart always does a full sync. That's also how
 * whitelist and overlay changes get picked up after a deploy.
 */
let lastEtag: string | undefined;

/**
 * Fetches the catalog.
 *
 * @returns
 * The parsed catalog, or null if it hasn't changed since the last fetch.
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

  // Only store the ETag once the body parsed, or a bad response would block the
  // next full fetch.
  lastEtag = response.headers.get('etag') ?? undefined;

  return catalog;
}

/**
 * Which endpoint serves an offering, or null if none does.
 *
 * models.dev rarely sets `type`, so embedding models are mostly spotted by name.
 */
export function toModelType(offering: CatalogOffering): ModelType | null {
  if (offering.type === 'embedding' || offering.id.toLowerCase().includes('embed')) {
    return 'embedding';
  }

  return offering.type ? null : 'chat';
}

/** Flattens a snapshot into rows for the upsert, with the overlay applied. */
export function selectOfferings(catalog: Catalog): SelectedOffering[] {
  const key = (item: SelectedOffering) => `${item.provider}/${item.type}/${item.offering.id}`;
  const overlaid = new Set(CATALOG_OVERLAY.map(key));

  const upstream = Object.entries(catalog.providers)
    .filter(([provider]) => providerWhitelist.has(provider))
    .flatMap(([provider, entry]) =>
      Object.values(entry.models).flatMap((offering) => {
        const type = toModelType(offering);
        return type ? [{ provider, type, offering }] : [];
      }),
    );

  return [...upstream.filter((item) => !overlaid.has(key(item))), ...CATALOG_OVERLAY];
}

/**
 * One sync pass. Fetches the catalog if it changed and upserts it.
 *
 * Throws if the fetch or parse fails. The caller logs it and the next tick
 * tries again.
 */
export async function tickModelCatalog(): Promise<void> {
  // Before the fetch, so excluded providers are removed even when the catalog
  // hasn't changed.
  const deleted = await deleteExcludedModels(keptProviders);
  if (deleted > 0) {
    logger.info({ deleted }, 'Deleted models from excluded providers');
  }
  const catalog = await fetchCatalog();

  if (!catalog) {
    logger.debug('models.dev catalog is unchanged');
    return;
  }

  const offerings = selectOfferings(catalog);
  const unpriced = offerings.filter((item) => !item.offering.cost).length;
  const summary = await upsertCatalog(offerings);

  logger.info(
    {
      providers: new Set(offerings.map((item) => item.provider)).size,
      offerings: offerings.length,
      unpriced: unpriced,
      written: summary.written,
      delisted: summary.delisted,
      confirmed: summary.confirmed,
    },
    'Synced models.dev catalog',
  );
}
