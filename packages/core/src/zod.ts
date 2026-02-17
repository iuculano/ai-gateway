/**
 * Normalizes a Postgres timestamp string to ISO 8601 format.
 *
 * @param input
 * The value to normalize. If not a string, it is returned unchanged.
 *
 * @returns
 * The normalized ISO timestamp string, or the original input if not a string.
 */
export function normalizeTimestamp(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }

  return `${input.replace(' ', 'T')}Z`;
}
