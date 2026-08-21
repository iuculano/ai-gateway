import { logger } from '@repo/core';
import { and, db, eq, inArray, isNull, notInArray, sql } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import type { CatalogOffering, SelectedOffering } from './catalog-sync';

export interface UpsertSummary {
  /** Rows the statement actually wrote - inserted, or updated because something moved. */
  written: number;

  /** Built-ins that stopped appearing upstream on this pass. */
  delisted: number;

  /** Rows confirmed present, whether or not they changed. */
  confirmed: number;
}

/** models.dev publishes only these two; anything else is treated as unremarkable. */
function toStatus(status: string | undefined): 'available' | 'beta' | 'deprecated' {
  return status === 'deprecated' || status === 'beta' ? status : 'available';
}

/**
 * The upstream fields no column holds yet.
 *
 * Kept rather than dropped, because the alternative when one of them is finally
 * needed is a full re-sync to recover data that was in the payload all along.
 */
function toConfig(offering: CatalogOffering): Record<string, unknown> {
  return {
    description: offering.description ?? null,
    family: offering.family ?? null,
    modalities: offering.modalities ?? null,
    knowledge: offering.knowledge ?? null,
    release_date: offering.release_date ?? null,
    last_updated: offering.last_updated ?? null,
    output_limit: offering.limit?.output ?? null,
    cost_cache_write: offering.cost?.cache_write ?? null,
    cost_reasoning: offering.cost?.reasoning ?? null,
  };
}

/**
 * One catalogue row, as the table wants it.
 *
 * Note that every price passes through `?? null` rather than `?? 0`. An absent
 * cost block means the price is unpublished, and the whole reason those columns
 * are nullable is so that fact survives the write.
 */
function toRow(item: SelectedOffering) {
  const { provider, offering } = item;

  return {
    source: 'builtin' as const,
    organization_id: null,
    provider: provider,
    name: offering.id,
    display_name: offering.name ?? null,
    status: toStatus(offering.status),
    cost_input: offering.cost?.input ?? null,
    cost_output: offering.cost?.output ?? null,
    cost_cache_read: offering.cost?.cache_read ?? null,
    context_limit: offering.limit?.context || null,
    attachment: offering.attachment ?? false,
    reasoning: offering.reasoning ?? false,
    tool_call: offering.tool_call ?? false,
    structured_output: offering.structured_output ?? false,
    config: toConfig(offering),
  };
}

/**
 * The columns a sync owns, compared as a row so one statement can decide
 * whether anything actually moved.
 *
 * `synced_at` is deliberately absent: it changes on every pass by definition,
 * and including it would make every row differ from itself and defeat the whole
 * comparison. It is set separately, below.
 */
const TRACKED = [
  'display_name',
  'status',
  'cost_input',
  'cost_output',
  'cost_cache_read',
  'context_limit',
  'attachment',
  'reasoning',
  'tool_call',
  'structured_output',
  'config',
  'delisted_at',
] as const;

/**
 * Writes one narrowed snapshot into `models`.
 *
 * Three statements in one transaction, each with a single job:
 *
 *  1. Upsert what arrived, touching only rows whose data actually differs.
 *  2. Mark absent built-ins delisted - never delete them, because a log from
 *     last month still needs the price to explain what it cost.
 *  3. Record that everything still present was confirmed on this pass.
 *
 * The split exists because `updated_at` and `synced_at` answer different
 * questions: one is "when did this change", the other "when did we last see
 * it". Folding them together makes a catalogue that has been quietly correct
 * for a week indistinguishable from one nothing has looked at.
 *
 * Custom rows are never touched. The conflict target is a partial index over
 * `source = 'builtin'`, and every statement below repeats that predicate.
 *
 * @param selected
 * The allowlisted offerings from one catalogue snapshot.
 */
export async function upsertCatalog(selected: SelectedOffering[]): Promise<UpsertSummary> {
  if (selected.length === 0) {
    return { written: 0, delisted: 0, confirmed: 0 };
  }

  const rows = selected.map(toRow);
  const providers = [...new Set(rows.map((row) => row.provider))];

  // Built column-wise so the two sides cannot fall out of step: Postgres
  // compares row constructors positionally, and a hand-written pair of lists
  // that drifted would silently compare the wrong columns.
  const current = sql.join(
    TRACKED.map((column) => sql.raw(`"models"."${column}"`)),
    sql`, `,
  );
  const incoming = sql.join(
    TRACKED.map((column) => sql.raw(`"excluded"."${column}"`)),
    sql`, `,
  );

  return db.transaction(async (tx) => {
    const written = await tx
      .insert(models)
      .values(rows)
      .onConflictDoUpdate({
        target: [models.provider, models.name],

        // Required, not optional: the unique index is partial, and without the
        // same predicate Postgres cannot tell which index this conflicts on.
        targetWhere: sql`${models.source} = 'builtin'`,

        set: {
          display_name: sql`excluded.display_name`,
          status: sql`excluded.status`,
          cost_input: sql`excluded.cost_input`,
          cost_output: sql`excluded.cost_output`,
          cost_cache_read: sql`excluded.cost_cache_read`,
          context_limit: sql`excluded.context_limit`,
          attachment: sql`excluded.attachment`,
          reasoning: sql`excluded.reasoning`,
          tool_call: sql`excluded.tool_call`,
          structured_output: sql`excluded.structured_output`,
          config: sql`excluded.config`,

          // A model that came back is no longer delisted.
          delisted_at: sql`null`,
          updated_at: sql`now()`,
        },

        // The row is left completely alone when nothing differs, which is what
        // keeps `updated_at` meaning "this model changed" rather than "the
        // worker ran". `tags` is absent from both lists on purpose - those are
        // the operator's labels, not the catalogue's.
        setWhere: sql`(${current}) IS DISTINCT FROM (${incoming})`,
      })
      .returning({ id: models.id });

    // Per provider, because "absent" is only meaningful within a provider that
    // was itself present. A provider missing from the payload entirely has
    // already been warned about and none of its rows are touched here.
    let delisted = 0;
    for (const provider of providers) {
      const names = rows.filter((row) => row.provider === provider).map((row) => row.name);

      const marked = await tx
        .update(models)
        .set({ delisted_at: sql`now()`, updated_at: sql`now()` })
        .where(
          and(
            eq(models.source, 'builtin'),
            eq(models.provider, provider),
            notInArray(models.name, names),
            isNull(models.delisted_at),
          ),
        )
        .returning({ id: models.id });

      delisted += marked.length;
    }

    // Last, so the delisted rows excluded above are already marked. This is the
    // only statement that runs against every row every pass, and it is also the
    // only one whose column nothing reads as a change.
    const confirmed = await tx
      .update(models)
      .set({ synced_at: sql`now()` })
      .where(and(eq(models.source, 'builtin'), inArray(models.provider, providers), isNull(models.delisted_at)))
      .returning({ id: models.id });

    logger.debug(
      { written: written.length, delisted: delisted, confirmed: confirmed.length },
      'Catalogue upsert complete',
    );

    return { written: written.length, delisted: delisted, confirmed: confirmed.length };
  });
}
