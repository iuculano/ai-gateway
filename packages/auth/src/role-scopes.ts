/**
 * Expands roles into the scopes they grant per the given mapping.
 *
 * The mapping itself is application policy and lives with the adapter that
 * calls this.
 *
 * @param roles
 * The role names held by the caller.
 *
 * @param roleMapping
 * Mapping of role names to the scopes each grants.
 *
 * @returns
 * Array of scopes granted by the caller's roles.
 */
export function rolesToScopes(roles: string[], roleMapping?: Record<string, string[]>): string[] {
  // Check if there's any work to do in the first place.
  if (!roleMapping) {
    return [];
  }

  // Just collect the scopes into a set to make duplicates impossible
  const granted = new Set<string>();

  for (const role of roles) {
    const scopes = roleMapping[role];
    if (!scopes) {
      continue;
    }

    for (const scope of scopes) {
      granted.add(scope);
    }
  }

  // Back to a (now deduped) array.
  return [...granted];
}
