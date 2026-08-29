import { diffFields, probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, isNull, lt, or } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import AuditLogServices from '../audit-logs/audit-logs.services';
import Schemas, {
  type CreateModelRequest,
  type CreateModelResponse,
  type DeleteModelResponse,
  type GetModelResponse,
  type ListModelsRequest,
  type ListModelsResponse,
  type ListProvidersResponse,
  type UpdateModelRequest,
  type UpdateModelResponse,
} from './models.schemas';

/**
 * The outcomes a caller can act on.
 *
 * Declared per operation rather than shared, so a code added to one cannot
 * silently widen the others. Note that models are a global catalogue - the
 * table has no organization_id - so none of these can be a tenancy refusal the
 * way the api-key and webhook ones are.
 *
 * Everything else here - a failed query, a row that will not parse, an insert
 * that returns nothing - is the system malfunctioning rather than an answer,
 * and rejects.
 */
export type GetModelFailure = {
  code: 'MODEL_NOT_FOUND';
  id: string;
};

/**
 * Carries the slug rather than an id, because that is what the caller asked
 * with and an id would be an answer this operation never found.
 */
export type GetModelBySlugFailure = {
  code: 'MODEL_NOT_FOUND';
  slug: string;
};

export type UpdateModelFailure = {
  code: 'MODEL_NOT_FOUND';
  id: string;
};

export type DeleteModelFailure = {
  code: 'MODEL_NOT_FOUND';
  id: string;
};

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
 * The whole catalogue, grouped by provider.
 *
 * Unpaginated on purpose. Every figure the dashboard shows for a provider - the
 * price range, the model count, the widest context - is an aggregate over all
 * of that provider's models, and a page boundary running through the middle of
 * one would turn each of those into a statement about a page instead. At the
 * low hundreds of rows the catalogue holds, that is a trade worth making;
 * listModels remains for anything that wants a cursor.
 *
 * Scoped to global rows plus the caller's own. Built-ins carry no
 * organization_id and belong to everyone; custom rows belong to exactly one
 * organization and must not be visible to another.
 *
 * Deliberately not a Result: an empty catalogue is a catalogue, and there is no
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

/**
 * Creates a new model in the database.
 *
 * Deliberately not a Result: nothing about a create is refusable today. There
 * is no uniqueness constraint on provider/name, so a duplicate is accepted
 * rather than rejected.
 *
 * @param request
 * The request object containing the model data to create.
 */
async function createModel(request: CreateModelRequest): Promise<CreateModelResponse> {
  const caller = getCaller();

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(models)
      .values({ ...request, organization_id: caller.organization.id, source: 'custom' })
      .returning();

    if (!row) {
      // Probably impossible: a returning() insert either throws or gives a row.
      throw new Error('Failed to create model');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'models.created',
        target_type: 'model',
        target_id: row.id,
        status: 'success',
        metadata: {
          source: row.source,
          provider: row.provider,
          name: row.name,
          display_name: row.display_name,
        },
      },
      tx,
    );

    return row;
  });

  const parsed = Schemas.createModel.response.parse(result);
  return parsed;
}

/**
 * Updates an existing model in the database.
 *
 * @param id
 * The ID of the model to update.
 *
 * @param request
 * The request object containing the updated model data.
 */
async function updateModel(
  id: string,
  request: UpdateModelRequest,
): Promise<Result<UpdateModelResponse, UpdateModelFailure>> {
  const result = await db.transaction(async (tx): Promise<Result<typeof models.$inferSelect, UpdateModelFailure>> => {
    const [existing] = await tx.select().from(models).where(eq(models.id, id)).for('update');

    // Almost guaranteed that the model doesn't exist.
    if (!existing) {
      return err({ code: 'MODEL_NOT_FOUND', id });
    }

    const writeableFields = Object.keys(Schemas.updateModel.body.shape);
    const { updates, difference } = diffFields(existing, request, writeableFields);

    if (Object.keys(difference).length === 0) {
      return ok(existing);
    }

    const [row] = await tx.update(models).set(updates).where(eq(models.id, id)).returning();

    if (!row) {
      throw new Error('Failed to update model');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'models.updated',
        target_type: 'model',
        target_id: row.id,
        status: 'success',
        difference,
      },
      tx,
    );

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.updateModel.response.parse(result.value);
  return ok(parsed);
}

/**
 * Deletes an existing model in the database.
 *
 * @param id
 * The ID of the model to delete.
 */
async function deleteModel(id: string): Promise<Result<DeleteModelResponse, DeleteModelFailure>> {
  const caller = getCaller();

  return db.transaction(async (tx): Promise<Result<DeleteModelResponse, DeleteModelFailure>> => {
    const [row] = await tx
      .delete(models)
      .where(and(eq(models.organization_id, caller.organization.id), eq(models.id, id)))
      .returning();

    if (!row) {
      return err({ code: 'MODEL_NOT_FOUND', id });
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'models.deleted',
        target_type: 'model',
        target_id: row.id,
        status: 'success',
        metadata: {
          source: row.source,
          provider: row.provider,
          name: row.name,
          display_name: row.display_name,
        },
      },
      tx,
    );

    return ok(undefined);
  });
}

export default {
  getModel,
  getModelBySlug,
  listModels,
  listProviders,
  createModel,
  updateModel,
  deleteModel,
};
