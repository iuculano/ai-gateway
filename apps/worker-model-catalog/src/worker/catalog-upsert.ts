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
 * Preserving them avoids a full re-sync when a field later needs a dedicated
 * feature or column.
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
 * Missing prices remain null because unpublished and free are different states.
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
 * `synced_at` is excluded because confirmation alone should not make the model
 * appear changed; it is updated separately.
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
 * Applies a catalogue snapshot atomically: update changed built-ins, delist
 * missing ones, and confirm the rest. `updated_at` tracks data changes while
 * `synced_at` tracks the latest confirmation; custom rows are never touched.
 *
 * @param selected
 * The offerings from one catalogue snapshot.
 */
export async function upsertCatalog(selected: SelectedOffering[]): Promise<UpsertSummary> {
  if (selected.length === 0) {
    return { written: 0, delisted: 0, confirmed: 0 };
  }

  const rows = selected.map(toRow);
  const providers = [...new Set(rows.map((row) => row.provider))];

  // Generate both positional tuples from one list so comparisons cannot drift.
  const current = sql.join(
    TRACKED.map((column) => sql.raw(`"models"."${column}"`)),
    sql`, `,
  );
  const incoming = sql.join(
    TRACKED.map((column) => sql.raw(`"excluded"."${column}"`)),
    sql`, `,
  );

  return db.transaction(async (tx) => {
    let written = 0;

    // Bound each statement to stay below PostgreSQL's parameter limit.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = await tx
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.provider, models.name],

          // PostgreSQL needs this predicate to select the partial unique index.
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

          // Avoid changing `updated_at` for confirmations alone. Operator-owned
          // tags are intentionally excluded from catalogue comparisons.
          setWhere: sql`(${current}) IS DISTINCT FROM (${incoming})`,
        })
        .returning({ id: models.id });

      written += batch.length;
    }

    // Absence is meaningful only for providers represented in this snapshot.
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

    // Confirm active rows after delisting so missing models are excluded.
    const confirmed = await tx
      .update(models)
      .set({ synced_at: sql`now()` })
      .where(and(eq(models.source, 'builtin'), inArray(models.provider, providers), isNull(models.delisted_at)))
      .returning({ id: models.id });

    logger.debug(
      { written, delisted: delisted, confirmed: confirmed.length },
      'Catalogue upsert complete',
    );

    return { written, delisted: delisted, confirmed: confirmed.length };
  });
}
