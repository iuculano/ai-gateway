import { probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, gt, lt, max, sql } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import { LRUCache } from 'lru-cache';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type ListProvidersQuery,
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
  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(models)
    .where(
      eq(models.id, id)
    );

  if (!row) {
    return err({ code: 'MODEL_NOT_FOUND', id });
  }

  const parsed = Schemas.getModel.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a single model by its `provider/name` slug.
 *
 * @param slug
 * The slug to look up.
 */
async function getModelBySlug(slug: string): Promise<Result<GetModelResponse, GetModelBySlugFailure>> {
  // Can't have a slug with a / at the start or end.
  const separator = slug.indexOf('/');
  if (separator <= 0 || separator === slug.length - 1) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  const cached = modelCache.get(slug);
  if (cached) {
    return ok(cached);
  }

  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(models)
    .where(and(
      eq(models.provider, slug.slice(0, separator)),
      eq(models.name, slug.slice(separator + 1))
    ));

  if (!row) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  const parsed = Schemas.getModel.response.parse(row);
  modelCache.set(slug, parsed);
  return ok(parsed);
}

export type ModelRoutingOptions = {
  strategy?: 'random' | 'weighted' | 'cost';
  weights?: string;
};

/**
 * Retrieves a list of models, filtered by the given criteria.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listModels(query: ListModelsRequest): Promise<ListModelsResponse> {
  const conditions = [
    query.name ? eq(models.name, query.name) : undefined,
    query.provider ? eq(models.provider, query.provider) : undefined,
    query.after_id ? lt(models.id, query.after_id) : undefined,
  ];

  // biome-ignore format: looks nicer
  const rows = await db
    .select()
    .from(models)
    .where(and(...conditions))
    .orderBy(desc(models.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);

  const parsed = Schemas.listModels.response.parse(page);
  return parsed;
}

/**
 * Retrieves a page of providers with their full model lists.
 *
 * Providers and their models are returned alphabetically.
 */
async function listProviders(query: ListProvidersQuery): Promise<ListProvidersResponse> {
  // biome-ignore format: looks nicer
  const rows = await db
    .select({
      id: models.provider,
      synced_at: max(models.synced_at),
      models: sql<GetModelResponse[]>`jsonb_agg(${models} ORDER BY ${models.name})`
        .mapWith((rows: GetModelResponse[]) => rows.map((row) => ({
          ...row,
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
          synced_at: row.synced_at === null ? null : new Date(row.synced_at),
          delisted_at: row.delisted_at === null ? null : new Date(row.delisted_at),
        }))),
    })
    .from(models)
    .where(query.after_id ? gt(models.provider, query.after_id) : undefined)
    .groupBy(models.provider)
    .orderBy(asc(models.provider))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);

  const parsed = Schemas.listProviders.response.parse(page);
  return parsed;
}

/**
 * Validates and orders a list of models based on the provided routing options.
 *
 * @param models
 * Comma separated list of models.
 *
 * @param options
 * The routing options to use for ordering the models.
 */
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
      const model = await getModelBySlug(slug);
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
    const remaining = candidates.map((slug, index) => ({ slug, weight: weights[index] as number }));

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

          const model = await getModelBySlug(candidate.slug);
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
      const model = await getModelBySlug(slug);
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
        const model = await getModelBySlug(slug);
        if (model.isErr()) {
          return undefined;
        }

        const { cost_input, cost_output } = model.value;
        const cost = cost_input != null && cost_output != null ? cost_input + cost_output : Number.POSITIVE_INFINITY; // Unknown prices sort last.

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

export default {
  getModel,
  getModelBySlug,
  listModels,
  listProviders,
  validateAndOrderModels,
};
