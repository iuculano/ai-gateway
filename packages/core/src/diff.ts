// Imported rather than reached for as the `Bun` global: the global is only in
// scope when a tsconfig happens to pick up @types/bun, which the packages here
// do not, and a shared package should not depend on its consumer's compiler
// options to type-check.
import { deepEquals } from 'bun';

/**
 * Field-level comparison between a stored row and a partial update.
 *
 * Both halves come from one pass because they answer different questions about
 * the same fields: `updates` is what to write, `difference` is what to tell the
 * audit log. A field the caller sent unchanged belongs in the first and not the
 * second.
 */

export interface FieldDiff<TRow> {
  /** Every field the caller actually sent, ready to hand to .set(). */
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
 * Which fields may be written. Callers derive this from their update schema
 * rather than hand-listing it, so a column omitted there stays unwritable here.
 *
 * @returns
 * The fields to write and the subset of those that changed. `difference` is
 * empty when the caller sent only values the row already had, which is the
 * signal to skip the write and the audit entirely.
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
    // this is "leave it", not "clear it". An explicit null does reach the
    // comparison below.
    if (next === undefined) {
      continue;
    }

    updates[field] = next;

    // deepEquals over JSON.stringify: same answers for these column types, but
    // it compares Dates and arrays directly instead of serialising both sides
    // to strings first.
    if (!deepEquals(existing[field], next)) {
      difference[field] = { old: existing[field], new: next };
    }
  }

  // Built loose and narrowed once on the way out. Typing `updates` as
  // Partial<TRow> up front would hit the same correlated-key limitation that
  // blocks `updates[field] = next` - TypeScript reads a union-keyed index fine
  // but refuses to write through one. Returning Partial<TRow> is what keeps
  // the caller's .set() actually type-checked; a bare Record<string, unknown>
  // satisfies it vacuously.
  return { updates: updates as Partial<TRow>, difference };
}
