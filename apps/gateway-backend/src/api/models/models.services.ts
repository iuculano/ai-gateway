import { probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, lt, or } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import { err, ok, type Result } from 'neverthrow';
import Schemas, {
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type ListProvidersResponse,
} from './models.schemas';

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
  // A malformed slug is deliberately not its own failure code. It answers the
  // same as one that simply is not there, which is the existing behaviour: a
  // caller probing for which providers exist learns nothing from the shape of
  // the refusal.
  const split = slug.split('/');
  if (split.length !== 2) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  const [result] = await db
    .select()
    .from(models)
    .where(and(eq(models.provider, split[0] as string), eq(models.name, split[1] as string)));

  if (!result) {
    return err({ code: 'MODEL_NOT_FOUND', slug });
  }

  // I'm wondering if I even need to cache here - the query is very cheap.
  // This endpoint is called on every inference, though, maybe worth it?
  const parsed = Schemas.getModel.response.parse(result);
  return ok(parsed);
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
