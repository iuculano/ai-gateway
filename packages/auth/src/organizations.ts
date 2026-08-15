import { and, db, eq } from '@repo/drizzle';
import { organizations } from '@repo/drizzle/schemas';
import { HTTPException } from 'hono/http-exception';

export interface Organization {
  id: string;
  name: string;
  status: string;
}

function toOrganization(row: typeof organizations.$inferSelect): Organization {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
  };
}

/** Turns a display name into a URL-safe slug fragment. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Looks up an organization by external identity and gates its active status.
 *
 * This lookup deliberately is not authorization-cached. Suspending a tenant
 * must affect the next authentication attempt.
 */
async function findOrganizationByExternalIdpId(issuer: string, id: string): Promise<Organization | null> {
  const [row] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.external_idp, issuer), eq(organizations.external_id, id)))
    .limit(1);

  if (!row) {
    return null;
  }

  if (row.status !== 'active') {
    throw new HTTPException(403, {
      cause: 'Organization is not active.',
    });
  }

  return toOrganization(row);
}

/**
 * Retrieves an organization by local id without applying authentication policy.
 * Callers such as the key adapter must decide how a non-active row is reported.
 */
export async function getOrganization(id: string): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);

  return row ? toOrganization(row) : null;
}

/**
 * Resolves and, on first sight, provisions an issuer-qualified organization.
 */
export async function resolveOrganization(issuer: string, id: string, name?: string): Promise<Organization> {
  const existing = await findOrganizationByExternalIdpId(issuer, id);
  if (existing) {
    return existing;
  }

  const displayName = name ?? id;

  try {
    const [row] = await db
      .insert(organizations)
      .values({
        external_idp: issuer,
        external_id: id,
        name: displayName,
        // Suffix with the external id so equal display names do not collide.
        slug: `${slugify(displayName) || 'org'}-${slugify(id)}`,
      })
      .returning();

    if (!row) {
      throw new Error('Failed to provision organization');
    }

    return toOrganization(row);
  } catch (error) {
    // Concurrent first logins for one tenant race on the unique identity.
    const retry = await findOrganizationByExternalIdpId(issuer, id);
    if (retry) {
      return retry;
    }
    throw error;
  }
}
