/**
 * Normalize a scopes claim into a list of scope names, regardless of whether
 * the IDP sends a space-delimited string or an array of strings.
 *
 * For whatever reason, Okta seems to have this behavior and uses an array.
 *
 * @param value
 * The raw value of the scopes claim from the IDP.
 *
 * @returns
 * An array of scope names, or an empty array if the claim is missing or
 * invalid.
 */
export function normalizeScopes(value: unknown): string[] {
  // Formatted like: 'scope1 scope2 scope3'
  if (typeof value === 'string') {
    return value.split(' ').filter(Boolean);
  }

  // If it's an array, it's already in the format we want.
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  return [];
}

/**
 * Normalize roles into an array of role names, regardless of whether the IDP
 * sends a string, an array of strings, or an object keyed by role name.
 *
 * @param value
 * The raw value of the roles claim from the IDP.
 *
 * @returns
 * An array of role names, or an empty array if the claim is missing or invalid.
 */
export function normalizeRoles(value: unknown): string[] {
  // Handle a single role sent as a bare string. An empty string means no roles.
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }

  // Roles listed as an array ['admin', 'viewer']. Filtered rather than cast:
  // the claim is untrusted input, and a mixed array would otherwise put
  // non-strings into a string[].
  if (Array.isArray(value)) {
    return value.filter((role): role is string => typeof role === 'string' && role.length > 0);
  }

  // Roles mapped as an object keys. For example, Zitadel...
  // {
  //   "admin": { "123": "zitadel.cloud" },
  //   "viewer": { "123": "zitadel.cloud" }
  // }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value);
  }

  // Missing claim or garbage (null, number, boolean) - nothing to return.
  return [];
}
