export interface Pair {
  key: string;
  value: string;
}

/**
 * A string map as the ordered list of pairs that the editor works on.
 */
export function toPairs(record?: Record<string, string> | null): Pair[] {
  // A list and not the map itself, because a map cannot hold a row that was
  // added and not yet typed into. Two such rows would collide on the empty key.
  return Object.entries(record ?? {}).map(([key, value]) => ({ key: key, value: value }));
}

/**
 * The pairs as the string map the API takes, without the rows that have no
 * key, or undefined when none are left.
 */
export function toRecord(pairs: Pair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};

  for (const pair of pairs) {
    const key = pair.key.trim();

    if (key.length > 0) {
      record[key] = pair.value.trim();
    }
  }

  // Undefined and not an empty map. The column is nullable, and an empty
  // filter would read as match nothing when the intent was to clear it.
  return Object.keys(record).length > 0 ? record : undefined;
}
