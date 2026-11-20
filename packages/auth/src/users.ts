import { generateActorId } from '@repo/core';
import { and, db, eq } from '@repo/drizzle';
import { type UserRow, userIdentities, users } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';

type User = UserRow;
type UserProvisionProfile = Pick<UserRow, 'username' | 'email' | 'name'>;

/**
 * Resolves an issuer-qualified external identity to an active local user.
 *
 * This lookup deliberately is not authorization-cached. User suspension must
 * take effect on the next authentication attempt, not after an in-process TTL.
 */
async function findUserByExternalIdentity(issuer: string, externalId: string): Promise<User | null> {
  // biome-ignore format: looks nicer
  const [row] = await db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.user_id, users.id))
    .where(and(
      eq(userIdentities.external_idp, issuer),
      eq(userIdentities.external_id, externalId)
    ));

  if (!row) {
    return null;
  }

  if (row.user.status !== 'active') {
    throw new HTTPException(403, {
      cause: 'User is not active',
    });
  }

  return row.user;
}

/**
 * Retrieves a user by local id.
 */
export async function getUserById(id: string): Promise<User | null> {
  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.id, id));

  return row ?? null;
}

/**
 * Resolves an external identity to a stable local user, provisioning both the
 * human and its issuer-qualified credential mapping on first sight. The stored
 * profile follows the identity provider afterwards.
 */
export async function resolveUser(issuer: string, externalId: string, profile: UserProvisionProfile): Promise<string> {
  const existing = await findUserByExternalIdentity(issuer, externalId);
  if (existing) {
    const changed =
      existing.username !== profile.username || existing.email !== profile.email || existing.name !== profile.name;

    if (changed) {
      // A rename is cosmetic, not really the end of the wworld if this fails.
      // Just log it and continue for now.
      try {
        // biome-ignore format: looks nicer
        await db
          .update(users)
          .set({ username: profile.username, email: profile.email, name: profile.name })
          .where(eq(users.id, existing.id));
      } catch (error) {
        getLogger().error({ err: error }, 'Failed to refresh user profile');
      }
    }

    return existing.id;
  }

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          id: generateActorId('user'),
          username: profile.username,
          email: profile.email,
          name: profile.name,
        })
        .returning({ id: users.id });

      if (!user) {
        throw new Error('Failed to provision user');
      }

      await tx.insert(userIdentities).values({
        user_id: user.id,
        external_idp: issuer,
        external_id: externalId,
      });

      return user.id;
    });
  } catch (error) {
    // Two first logins for the same issuer/subject can race. The unique index
    // rejects the loser - just re-read in this case.
    const retry = await findUserByExternalIdentity(issuer, externalId);
    if (retry) {
      return retry.id;
    }

    throw error;
  }
}
