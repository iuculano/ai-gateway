import { and, db, eq, inArray, sql } from '@repo/drizzle';
import { apiKeys, users } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
import Schemas, { type ResolveActorsBody, type ResolveActorsResponse } from './actors.schemas';

async function resolveUsers(ids: string[]): Promise<{ id: string; name: string }[]> {
  // biome-ignore format: looks nicer
  const rows = await db
    .select({ id: users.id, name: sql<string>`coalesce(${users.name}, ${users.username})` })
    .from(users)
    .where(inArray(users.id, ids));

  return rows;
}

async function resolveApiKeys(ids: string[]): Promise<{ id: string; name: string }[]> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.name })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.organization_id, caller.organization.id),
      inArray(apiKeys.id, ids)
    ));

  return rows;
}

/** Resolve a batch of actor references to their corresponding names.
 *
 * @param body
 * The request body containing actor references to resolve.
 */
async function resolveActors(body: ResolveActorsBody): Promise<ResolveActorsResponse> {
  // The payload is a union, break  it down to the actual respective types
  // and filter duplicates if any.
  const userIds = [
    ...new Set(body.actors.filter((actor) => actor.actor_type === 'user').map((actor) => actor.actor_id)),
  ];

  const keyIds = [
    ...new Set(body.actors.filter((actor) => actor.actor_type === 'api_key').map((actor) => actor.actor_id)),
  ];

  // Try to save some time and just query concurrently.
  const [userRows, keyRows] = await Promise.all([
    userIds.length ? resolveUsers(userIds) : Promise.resolve([]),
    keyIds.length ? resolveApiKeys(keyIds) : Promise.resolve([]),
  ]);

  // id -> name lookup table
  const userNames = new Map(userRows.map((row) => [row.id, row.name]));
  const apiKeyNames = new Map(keyRows.map((row) => [row.id, row.name]));

  const result = Schemas.resolveActors.response.parse({
    data: body.actors.map((actor) => {
      const name =
        actor.actor_type === 'system'
          ? 'System'
          : actor.actor_type === 'user'
            ? userNames.get(actor.actor_id)
            : apiKeyNames.get(actor.actor_id);

      return { ...actor, display: name === undefined ? null : { name } };
    }),
  });

  return result;
}

export default {
  resolveActors,
};
