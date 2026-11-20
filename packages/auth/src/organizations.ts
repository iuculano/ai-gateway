import { and, db, eq } from '@repo/drizzle';
import { type OrganizationRow, organizationMembers, organizations } from '@repo/drizzle/schemas';
import { HTTPException } from 'hono/http-exception';

/**
 * Simplified representation of an organization.
 */
export interface Organization {
  id: string;
  name: string;
  status: string;
}

/**
 * Converts a database row into an Organization object.
 *
 * @param row
 * The database row representing an organization.
 *
 * @returns
 * The corresponding Organization object.
 */
function toOrganization(row: Pick<OrganizationRow, 'id' | 'name' | 'status'>): Organization {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
  };
}

/**
 * Turns a display name into a URL-safe slug.
 *
 * Collapses non-alphanumeric characters into a single dash, lowercases, and
 * trims leading and trailing dashes.
 *
 * @param value
 * The display name to convert.
 *
 * @returns
 * A URL-safe slug derived from the display name.
 */
function toSlug(value: string): string {
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
 *
 * @param issuer
 * The external identity provider's issuer.
 *
 * @param organizationId
 * The external identity provider's organization id.
 *
 * @param userId
 * The local id of the user authenticating under the organization.
 *
 * In practice, this is basically just an optimization to save an additional
 * lookup...
 *
 * @returns
 * The organization if found and active, with the user's id when they are
 * already recorded as a member of it, or null if not found.
 */
async function findOrganizationByExternalIdpId(
  issuer: string,
  organizationId: string,
  userId: string,
): Promise<{ organization: Organization; userId: string | null } | null> {
  // biome-ignore format: looks nicer
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      status: organizations.status,
      member_id: organizationMembers.user_id,
    })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organization_id, organizations.id),
        eq(organizationMembers.user_id, userId)
      ),
    )
    .where(and(
      eq(organizations.external_idp, issuer),
      eq(organizations.external_id, organizationId)
    ));

  if (!row) {
    return null;
  }

  if (row.status !== 'active') {
    throw new HTTPException(403, {
      cause: 'Organization is not active.',
    });
  }

  return { organization: toOrganization(row), userId: row.member_id };
}

/**
 * Retrieves an organization by local id without applying authentication policy.
 * Callers must decide how a non-active row is reported.
 */
export async function getOrganization(id: string): Promise<Organization | null> {
  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));

  return row ? toOrganization(row) : null;
}

/**
 * Provisions an organization seen for the first time.
 */
async function provisionOrganization(issuer: string, organizationId: string, name?: string): Promise<Organization> {
  const displayName = name ?? organizationId;

  const [row] = await db
    .insert(organizations)
    .values({
      external_idp: issuer,
      external_id: organizationId,
      name: displayName,
      slug: `${toSlug(displayName) || 'org'}-${toSlug(organizationId)}`, // Suffix with the external id so equal display names do not collide.
    })
    .returning();

  if (!row) {
    throw new Error('Failed to provision organization');
  }

  return toOrganization(row);
}

/**
 * Resolves and, on first sight, provisions an issuer-qualified organization.
 * The authenticating user is recorded as a member of it.
 *
 * @param issuer
 * The external identity provider's issuer.
 *
 * @param organizationId
 * The external identity provider's organization id.
 *
 * @param userId
 * The local id of the user authenticating under the organization.
 *
 * @param name
 * Optional display name for the organization. If not provided, the external id
 * is used.
 *
 * @returns
 * The resolved or newly provisioned organization.
 */
export async function resolveOrganization(
  issuer: string,
  organizationId: string,
  userId: string,
  name?: string,
): Promise<Organization> {
  let found = await findOrganizationByExternalIdpId(issuer, organizationId, userId);

  // If the organization exists
  if (!found) {
    try {
      const organization = await provisionOrganization(issuer, organizationId, name);
      found = { organization, userId: null };
    } catch (error) {
      // Concurrent first logins for one tenant race on the unique identity.
      found = await findOrganizationByExternalIdpId(issuer, organizationId, userId);
      if (!found) {
        throw error;
      }
    }
  }

  // If the user under the organization is not yet a member
  if (!found.userId) {
    await db
      .insert(organizationMembers)
      .values({ organization_id: found.organization.id, user_id: userId })
      .onConflictDoNothing();
  }

  return found.organization;
}
