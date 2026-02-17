/**
 * Helpers for parsing tags from query parameters.
 *
 * @param tags
 * A comma-separated string of tags to filter by.
 *
 * Expected format is: "key1:value1,key2:value2"
 *
 * @returns
 * A record/object mapping tag keys to values.
 */
export function parseTags(tags: string | undefined): Record<string, string> | undefined {
  if (!tags) {
    return undefined;
  }

  const tagsToFilter: Record<string, string> = {};

  const pairs = tags.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split(':');

    if (key && value) {
      tagsToFilter[key] = value;
    }
  }

  return tagsToFilter;
}
