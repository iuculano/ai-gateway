/**
 * Shape of a response page.
 */
export interface Page<TRow> {
  data: TRow[];
  meta: {
    oldest_id: string | null;
    more_data: boolean;
  };
}

/**
 * Used to check if there are more rows than the caller requested.
 */
export function probe(limit: number): number {
  return limit + 1;
}

// The 2-parameter form. Refuses a TRow without a string id property, which is
// what makes omitting getId safe. toPage() falls back to row.id, and the
// constraint is the proof that it exists.
export function toPage<TRow extends { id: string }>(rows: TRow[], limit: number): Page<TRow>;

// TRow is unconstrained, so getId is required to say where the cursor value
// comes from. Needed when the id isn't at the top level.
export function toPage<TRow>(rows: TRow[], limit: number, getId: (row: TRow) => string): Page<TRow>;

/**
 * Trims the probe row and derives the cursor metadata.
 *
 * @param rows
 * The result of a query limited with probe(limit).
 *
 * @param limit
 * How many rows the caller actually wants. This should be the same number that
 * was passed to probe() to get the rows.
 *
 * @param getId
 * Pulls the cursor id off a row, when it isn't at the top level.
 *
 * @returns
 * The trimmed rows plus cursor metadata.
 */
export function toPage<TRow>(rows: TRow[], limit: number, getId?: (row: TRow) => string): Page<TRow> {
  const moreData = rows.length > limit;

  // Sliced rather than popped - this array belongs to the caller.
  // Need to create another so we don't modify the original.
  const data = moreData ? rows.slice(0, limit) : rows;
  const oldest = data.at(-1);

  // Safe by construction rather than by check: the only overload that lets
  // getId be omitted constrains TRow to { id: string }, so a row shape without
  // one cannot reach this branch. The cast exists because the implementation
  // signature has to cover both overloads and so can't carry the constraint.
  const resolveId = getId ?? ((row: TRow) => (row as { id: string }).id);

  return {
    data,
    meta: {
      oldest_id: oldest ? resolveId(oldest) : null,
      more_data: moreData,
    },
  };
}
