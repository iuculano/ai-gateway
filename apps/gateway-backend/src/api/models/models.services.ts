import { probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, lt, or } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import { LRUCache } from 'lru-cache';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type ListProvidersResponse,
} from './models.schemas';

const modelCache = new LRUCache<string, GetModelResponse>({
  max: 1000,
  ttl: 1000 * 60 * 5, // 5 minutes
});

// The underlying error definitions.
type ModelNotFoundFailure = {
  code: 'MODEL_NOT_FOUND';
  id: string;
};

/**
 * Carries the slug rather than an id, because that is what the caller asked
 * with and an id would be an answer this operation never found.
 */
type ModelNotFoundBySlugFailure = {
  code: 'MODEL_NOT_FOUND';
  slug: string;
};

// The public service failure unions.
export type GetModelFailure = ModelNotFoundFailure;
export type GetModelBySlugFailure = ModelNotFoundBySlugFailure;

/**
 * Retrieves a single model by its ID.
 *
 * @param id
 * The ID of the model to retrieve.
 */
async function getModel(id: string): Promise<Result<GetModelResponse, GetModelFailure>> {
  const result = await db.select().from(models).where(eq(models.id, id));

  if (!result[0]) {
    return err({ code: 'MODEL_NOT_FOUND', id });
  }

  const parsed = Schemas.getModel.response.parse(result[0]);
  return ok(parsed);
}

/**
 * Retrieves a single model by its `provider/name` slug.
 *
 * @param slug
 * The slug to look up, as `provider/name`.
 */
async function getModelBySlug(slug: string): Promise<Result<GetModelResponse, GetModelBySlugFailure>> {
  const separator = slug.indexOf('/');
  if (separator <= 0 || separator === slug.length - 1) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  const cached = modelCache.get(slug);
  if (cached) {
    return ok(cached);
  }

  // biome-ignore format: looks nicer
  const [result] = await db
    .select()
    .from(models)
    .where(and(
      eq(models.provider, slug.slice(0, separator)),
      eq(models.name, slug.slice(separator + 1))
    ));

  if (!result) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  const parsed = Schemas.getModel.response.parse(result);
  modelCache.set(slug, parsed);
  return ok(parsed);
}

export type ModelRoutingOptions = {
  strategy?: 'random' | 'weighted' | 'cost';
  weights?: string;
};

async function validateAndOrderModels(models: string, options: ModelRoutingOptions): Promise<string[] | undefined> {
  // So you can't do something like "openai/a,,google/b" and get an empty
  // string as a candidate.
  const candidates = models.split(',').map((model) => model.trim());

  // If there is no routing strategy specified, just return the candidates
  // as-is.
  const strategy = options.strategy;
  if (!strategy) {
    const output: string[] = [];
    for (const slug of candidates) {
      const model = await ModelsService.getModelBySlug(slug);
      if (model.isErr()) {
        continue;
      }

      output.push(slug);
    }

    return output.length > 0 ? output : undefined;
  }

  if (strategy === 'weighted') {
    // Comes through as strings since it's a header, parse into numbers.
    const strings = options.weights?.split(',').map((weight) => weight.trim()) ?? [];
    const weights = strings.map(Number);

    // Make sure we have sane numbers as weights.
    if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
      return undefined;
    }

    // Probably likely to cause weird/unexpected results? I don't think this
    // would work?
    if (weights.length !== candidates.length) {
      return undefined;
    }

    // Requested models and their weights together.
    const remaining = candidates
      .map((slug, index) => ({ slug, weight: weights[index] as number }));


    const output: string[] = [];

    // For example:
    // Weights: [70, 20, 10], roll: 85
    // index 0: 85 - 70 = 15 -> continue
    // index 1: 15 - 20 = -5 -> return candidates[1]
    // Once we're in the negatives, we're at the right index.
    // Try to build this whole list in one go.
    while (remaining.length > 0) {
      const total = remaining.reduce((sum, model) => sum + model.weight, 0);
      let roll = Math.random() * total;

      // Find the candidate based on the roll.
      for (let index = 0; index < remaining.length; index++) {
        // biome-ignore lint: can't be out of bounds
        const candidate = remaining[index]!;
        roll -= candidate.weight;

        // Nothing left and somehow roll landed on exactly zero, just force
        // the last candidate.
        const weirdness = index === remaining.length - 1;
        if (roll < 0 || weirdness) {
          remaining.splice(index, 1); // Remove candidate from future rolls

          const model = await ModelsService.getModelBySlug(candidate.slug);
          if (model.isOk()) {
            output.push(candidate.slug);
          }

          break;
        }
      }
    }

    return output.length > 0 ? output : undefined;
  }

  if (strategy === 'random') {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = candidates[i] as string;
      candidates[i] = candidates[j] as string;
      candidates[j] = temp;
    }

    const output: string[] = [];
    for (const slug of candidates) {
      const model = await ModelsService.getModelBySlug(slug);
      if (model.isErr()) {
        continue;
      }

      output.push(slug);
    }

    return output.length > 0 ? output : undefined;
  }

  if (strategy === 'cost') {
    // Grab the slug and cost so we can sort.
    const models = await Promise.all(
      candidates.map(async (slug) => {
        const model = await ModelsService.getModelBySlug(slug);
        if (model.isErr()) {
          return undefined;
        }

        const { cost_input, cost_output } = model.value;
        const cost = cost_input != null && cost_output != null
          ? cost_input + cost_output
          : Number.POSITIVE_INFINITY; // Unknown prices sort last.

        return { slug, cost };
      }),
    );

    // Filter any models we failed to retrieve.
    const valid = models.filter((model) => model !== undefined);
    if (valid.length === 0) {
      return undefined;
    }

    const sorted = valid.sort((x, y) => x.cost - y.cost);
    return sorted.map(({ slug }) => slug);
  }

  return undefined;
}

/**
 * Retrieves a list of models, filtered by the given criteria.
 *
 * Deliberately not a Result: an empty page is a page, and there is no outcome
 * here the caller could correct.
 *
 * @param request
 * The request object containing the filter criteria.
 */
async function listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
  const conditions = [
    request.name ? eq(models.name, request.name) : undefined,
    request.provider ? eq(models.provider, request.provider) : undefined,
    request.after_id ? lt(models.id, request.after_id) : undefined,
  ].filter((x) => x !== undefined);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = await db.select().from(models).where(whereClause).orderBy(desc(models.id)).limit(probe(request.limit));

  const parsed = Schemas.listModels.response.parse(toPage(rows, request.limit));

  return parsed;
}

/**
 * The whole catalog, grouped by provider.
 *
 * Unpaginated on purpose. Every figure the dashboard shows for a provider - the
 * price range, the model count, the widest context - is an aggregate over all
 * of that provider's models, and a page boundary running through the middle of
 * one would turn each of those into a statement about a page instead. At the
 * low hundreds of rows the catalog holds, that is a trade worth making;
 * listModels remains for anything that wants a cursor.
 *
 * Scoped to global rows plus the caller's own. Built-ins carry no
 * organization_id and belong to everyone; custom rows belong to exactly one
 * organization and must not be visible to another.
 *
 * Deliberately not a Result: an empty catalog is a catalog, and there is no
 * outcome here a caller could correct.
 */
async function listProviders(): Promise<ListProvidersResponse> {
  const organizationId = getCaller().organization.id;

  const rows = await db
    .select()
    .from(models)
    .where(or(isNull(models.organization_id), eq(models.organization_id, organizationId)))
    .orderBy(asc(models.provider), asc(models.name));

  // Grouped from the raw rows rather than parsed ones. The response shape
  // transforms dates into strings, so it is not idempotent - running it over
  // its own output would reject every timestamp it had already converted.
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = grouped.get(row.provider);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.provider, [row]);
    }
  }

  const data = [...grouped.entries()].map(([provider, providerRows]) => ({
    id: provider,
    synced_at: providerRows.reduce<Date | null>(
      (latest, row) => (row.synced_at && (!latest || row.synced_at > latest) ? row.synced_at : latest),
      null,
    ),
    models: providerRows,
  }));

  return Schemas.listProviders.response.parse({ data });
}

export default { getModel, getModelBySlug, getModelsBySlugs, listModels, listProviders };
