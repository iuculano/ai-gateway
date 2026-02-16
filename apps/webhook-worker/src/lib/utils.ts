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
function parseTags(tags: string | undefined): Record<string, string> | undefined {
  // Allow early exit if no tags are provided, just pass through.
  if (!tags) {
    return undefined;
  }

  const tagsToFilter: Record<string, string> = {};

  // Expected format is "key1:value1,key2:value2".
  const pairs = tags.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split(':');

    if (key && value) {
      tagsToFilter[key] = value;
    }
  }

  return tagsToFilter;
}

export { 
  parseTags,
};
