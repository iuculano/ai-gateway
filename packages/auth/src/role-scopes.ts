/**
 * Expands roles into the scopes they grant per the given mapping.
 *
 * The mapping itself is application policy and lives with the adapter that
 * calls this.
 *
 * @param roles The role names held by the caller.
 *
 * @param roleMapping Mapping of role names to the scopes each grants.
 */
export function rolesToScopes(roles: string[], roleMapping?: Record<string, string[]>): string[] {
  if (!roleMapping) {
    return [];
  }

  const granted = new Set<string>();
  for (const role of roles) {
    const scopes = roleMapping[role];
    if (!scopes) {
      continue; // No corresponding mapping
    }

    for (const scope of scopes) {
      granted.add(scope);
    }
  }

  return [...granted];
}
