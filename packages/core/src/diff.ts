import { deepEquals } from 'bun';

/**
 * Field-level comparison between a stored row and a partial update.
 */
export interface FieldDiff<TRow> {
  /** Every field the caller actually sent. */
  updates: Partial<TRow>;

  /** Only the fields whose value changed, as before/after pairs. */
  difference: Record<string, { old: unknown; new: unknown }>;
}

/**
 * Compares `patch` against `existing` over an explicit field list.
 *
 * @param existing
 * The stored row.
 *
 * @param patch
 * The update body. Fields absent from it are left alone - `undefined` means
 * "not sent", which is distinct from an explicit null.
 *
 * @param fields
 * Which fields may be written.
 *
 * @returns
 * The fields to write and the subset of those that changed.
 */
export function diffFields<TRow extends Record<string, unknown>>(
  existing: TRow,
  patch: Partial<Record<keyof TRow & string, unknown>>,
  fields: readonly string[],
): FieldDiff<TRow> {
  const updates: Record<string, unknown> = {};
  const difference: Record<string, { old: unknown; new: unknown }> = {};

  for (const field of fields) {
    const next = patch[field];

    // Absent from the patch rather than set to nothing - PATCH semantics, so
    // this is "leave it", not "clear it". An explicit null reaches the
    // comparison below.
    if (next === undefined) {
      continue;
    }

    updates[field] = next;

    if (!deepEquals(existing[field], next)) {
      difference[field] = { old: existing[field], new: next };
    }
  }

  return { updates: updates as Partial<TRow>, difference };
}
