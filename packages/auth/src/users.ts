import { and, db, eq } from '@repo/drizzle';
import { type UserRow, userIdentities, users } from '@repo/drizzle/schemas';
import { HTTPException } from 'hono/http-exception';

type User = UserRow;
type UserProvisionProfile = Pick<UserRow, 'username' | 'email' | 'name'>;

/**
 * Resolves an issuer-qualified external identity to an active local user.
 *
 * This lookup deliberately is not authorization-cached. User suspension must
 * take effect on the next authentication attempt, not after an in-process TTL.
 */
async function findUserByExternalIdentity(issuer: string, externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id, status: users.status })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.user_id, users.id))
    .where(and(eq(userIdentities.external_idp, issuer), eq(userIdentities.external_id, externalId)))
    .limit(1);

  if (!row) {
    return null;
  }

  if (row.status !== 'active') {
    throw new HTTPException(403, {
      cause: 'User is not active',
    });
  }

  return row.id;
}

/**
 * Claims a pre-user_identities row for an issuer without breaking its existing
 * foreign keys. Setting users.external_id to null makes the bridge one-shot:
 * another issuer with the same subject cannot later collapse onto this human.
 */
async function claimLegacyIdentity(issuer: string, externalId: string): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      const [legacy] = await tx
        .update(users)
        .set({ external_id: null })
        .where(eq(users.external_id, externalId))
        .returning({ id: users.id, status: users.status });

      if (!legacy) {
        return null;
      }

      if (legacy.status !== 'active') {
        throw new HTTPException(403, {
          cause: 'User is not active',
        });
      }

      await tx.insert(userIdentities).values({
        user_id: legacy.id,
        external_idp: issuer,
        external_id: externalId,
      });

      return legacy.id;
    });
  } catch (error) {
    // A concurrent request may have created the exact identity first.
    const retry = await findUserByExternalIdentity(issuer, externalId);
    if (retry) {
      return retry;
    }
    throw error;
  }
}

/**
 * Retrieves a user by local id.
 *
 * Full rows are read on every key-authentication attempt so a deleted owner is
 * rejected immediately. Profile caching belongs above this authorization gate.
 */
export async function getUserById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return row ?? null;
}

/**
 * Resolves an external identity to a stable local user, provisioning both the
 * human and its issuer-qualified credential mapping on first sight.
 */
export async function resolveUser(issuer: string, externalId: string, profile: UserProvisionProfile): Promise<string> {
  const existing = await findUserByExternalIdentity(issuer, externalId);
  if (existing) {
    return existing;
  }

  const legacy = await claimLegacyIdentity(issuer, externalId);
  if (legacy) {
    return legacy;
  }

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
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
    // rejects the loser; re-reading turns that expected conflict into success.
    const retry = await findUserByExternalIdentity(issuer, externalId);
    if (retry) {
      return retry;
    }
    throw error;
  }
}
