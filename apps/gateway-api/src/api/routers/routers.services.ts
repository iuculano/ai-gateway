import { HTTPException } from 'hono/http-exception';
import { and, db, eq, lt, sql } from '@lib/drizzle';
import { parseTags } from '@lib/utils';
import { routers, routerVersions } from '@db/schemas/routers';
import Schemas, {
  type CreateRouterBody,
  type CreateRouterResponse,
  type CreateRouterVersionBody,
  type CreateRouterVersionResponse,
  type DeleteRouterResponse,
  type GetRouterResponse,
  type GetRouterVersionResponse,
  type ListRoutersQuery,
  type ListRoutersResponse,
  type ListRouterVersionsQuery,
  type ListRouterVersionsResponse,
  type UpdateRouterBody,
  type UpdateRouterResponse,
  type UpdateRouterVersionBody,
  type UpdateRouterVersionResponse,
} from './routers.schemas';

/**
 * Retrieves a single router by its ID.
 *
 * @param id
 * The ID of the router to retrieve.
 *
 * @returns
 * A promise that resolves to the router data.
 */
async function getRouter(id: string) : Promise<GetRouterResponse> {
  const result = await db.select()
    .from(routers)
    .where(eq(routers.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getRouter.response.parse(result[0]);
  return parsed;
}

    /**
 * Retrieves a list of prompts, filtered by the given criteria.
 *
 * @param query
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the router data.
 */
async function listRouters(query: ListRoutersQuery) : Promise<ListRoutersResponse> {
  const tagsToFilter = parseTags(query.tags);

  const conditions = [
    query.tags      ? sql`${routers.tags} @> ${tagsToFilter}::jsonb` : undefined,
    query.after_id  ? lt(routers.id, query.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(routers)
    .where(whereClause)
    .limit(query.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > query.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listRouters.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new router entry in the database.
 *
 * @param body
 * The request object containing the router data to be created.
 *
 * @returns
 * A promise that resolves to the created router data.
 */
async function createRouter(body: CreateRouterBody) : Promise<CreateRouterResponse> {
  const result = await db.insert(routers)
    .values(body)
    .returning();

  const parsed = Schemas.createRouter.response.parse({
    ...result[0],
    active_version: null
  });
  return parsed;
}

/**
 * Updates an existing router entry in the database.
 *
 * @param id
 * The ID of the router to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated router data.
 */
async function updateRouter(id: string, body: UpdateRouterBody) : Promise<UpdateRouterResponse> {
  const result = await db.update(routers)
    .set(body)
    .where(eq(routers.id, id))
    .returning();

  const parsed = Schemas.updateRouter.response.parse(result[0]);
  return parsed;
}

/**
 * Deletes an existing log.
 *
 * @param id
 * The ID of the log to delete.
 *
 * @returns
 * A promise that resolves to nothing.
 */
async function deleteRouter(id: string) : Promise<DeleteRouterResponse> {
  const result = await db.delete(routers)
    .where(eq(routers.id, id))
    .returning();

  if (result.length === 0) {
    throw new HTTPException(404);
  }
}

/**
 * Retrieves a single router version by its ID.
 *
 * @param id
 * The ID of the router to retrieve.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function getRouterVersion(id: string, version: number) : Promise<GetRouterVersionResponse> {
  const result = await db.select()
    .from(routerVersions)
    .where(and(
      eq(routerVersions.router_id, id),
      eq(routerVersions.version, version),
    ));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getRouterVersion.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a list of prompt versions for a given prompt ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 * 
 * @param query
 * The filter criteria for pagination, etc.
 *
 * @returns
 * A promise that resolves to the router version data.
 */
async function listRouterVersions(id: string, query: ListRouterVersionsQuery) : Promise<ListRouterVersionsResponse> {
  const conditions = [
    query.after_id ? lt(routerVersions.id, query.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(routerVersions)
    .where(whereClause)
    .limit(query.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > query.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listRouterVersions.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new router version.
 * 
 * @param id
 * The ID of the parent router for which to create a new version.
 *
 * @param body
 * The request object containing the router version data to be created.
 *
 * @returns
 * A promise that resolves to the created router data.
 */
async function createRouterVersion(id: string, body: CreateRouterVersionBody) : Promise<CreateRouterVersionResponse> {

  // Needs to be atomic since we have to compute the next version number based
  // on existing versions for this router.
  const parsed = await db.transaction(async (tx) => {

    // Lock the parent prompt row to prevent concurrent version creation which
    // could result in duplicate/wrong version numbers.
    //
    // That is, as long as every "create version" ransaction takes that same
    // parent-row lock first, inserts into prompt_versions for that prompt_id
    // will effectively serialize per prompt.
    await tx.execute(sql`
      SELECT 1
      FROM ${routers}
      WHERE ${routers.id} = ${id}
      FOR UPDATE
    `);

    // Insert with computed next version (per router_id)
    const result = await tx.insert(routerVersions)
      .values({
        router_id: id,
        rules: body.rules,

        // next version = max(version) + 1 for this router
        version: sql`
        (
          SELECT COALESCE(MAX(${routerVersions.version}), 0) + 1
          FROM ${routerVersions}
          WHERE ${routerVersions.router_id} = ${id}
        )
        `,
      })
      .returning();

    return Schemas.createRouterVersion.response.parse(result[0]);
  });

  return parsed;
}

async function updateRouterVersion(id: string, version: number, body: UpdateRouterVersionBody) : Promise<UpdateRouterVersionResponse> {
  const result = await db.update(routerVersions)
    .set(body)
    .where(and(
      eq(routerVersions.router_id, id),
      eq(routerVersions.version, version),
    ))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.updateRouterVersion.response.parse(result[0]);
  return parsed;
}

async function deleteRouterVersion(id: string, version: number) : Promise<void> {
  const result = await db.delete(routerVersions)
    .where(and(
      eq(routerVersions.router_id, id),
      eq(routerVersions.version, version),
    ))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }
}

export default {
  getRouter,
  listRouters,
  createRouter,
  updateRouter,
  deleteRouter,

  getRouterVersion,
  listRouterVersions,
  createRouterVersion,
  updateRouterVersion,
  deleteRouterVersion,
}
