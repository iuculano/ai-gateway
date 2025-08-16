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

  // Postgres timestamps are returned as strings in the format
  // "YYYY-MM-DD HH:MM:SS".
  //
  // Replacing the space with 'T' and appending 'Z' is sufficient to pass Zod
  // validation for ISO 8601 format.
  return `${input.replace(' ', 'T')}Z`;
}
