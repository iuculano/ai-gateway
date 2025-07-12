/**
 * Normalizes a Postgres timestamp string to ISO 8601 format.
 *
 * Postgres timestamps are returned as strings in the format "YYYY-MM-DD
 * HH:MM:SS". This function converts such strings to the ISO format
 * "YYYY-MM-DDTHH:MM:SSZ" so Zod can validate it as a ISO 8601 string.
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
