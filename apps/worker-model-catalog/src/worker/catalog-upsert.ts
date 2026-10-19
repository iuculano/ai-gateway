import { logger } from '@repo/core';
import { and, db, eq, isNull, notInArray, or, sql } from '@repo/drizzle';
import { models } from '@repo/drizzle/schemas';
import type { CatalogOffering, SelectedOffering } from './catalog-sync';

export interface UpsertSummary {
  /** Rows inserted, or updated because something changed. */
  written: number;

  /** Models that disappeared upstream this pass. */
  delisted: number;

  /** Rows still listed upstream, changed or not. */
  confirmed: number;
}

/** models.dev only uses these two statuses. Anything else counts as available. */
function toStatus(status: string | undefined): 'available' | 'beta' | 'deprecated' {
  return status === 'deprecated' || status === 'beta' ? status : 'available';
}

/**
 * Upstream fields that don't have a column yet.
 *
 * Kept so a future column can be filled without a full re-sync.
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
 * One catalog row in table form.
 *
 * Missing prices stay null, since unknown and free aren't the same thing.
 */
function toRow(item: SelectedOffering) {
  const { provider, offering } = item;

  return {
    provider: provider,
    name: offering.id,
    type: item.type,
    redirect_to: item.redirect_to ?? null,
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
 * The columns the sync owns. They're compared as a row to decide whether
 * anything changed, and copied from the incoming row when it did.
 *
 * `synced_at` is left out so a plain confirmation doesn't count as a change.
 * `delisted_at` is included because incoming rows never set it, which clears it
 * when a delisted model comes back.
 */
const TRACKED = [
  'redirect_to',
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
 * Applies one catalog snapshot in a single transaction. Changed models are
 * updated, missing ones are delisted, and the rest are confirmed.
 *
 * `updated_at` moves when data changes. `synced_at` moves on every confirmation.
 *
 * @param selected
 * The offerings from one catalog snapshot.
 */
export async function upsertCatalog(selected: SelectedOffering[]): Promise<UpsertSummary> {
  if (selected.length === 0) {
    return { written: 0, delisted: 0, confirmed: 0 };
  }

  const rows = selected.map(toRow);

  // Delisting only applies within a provider and type that appear in this
  // snapshot. Type matters because the overlay's rows would otherwise make a
  // provider look present even when models.dev left it out.
  //
  // Known gap. Removing the last overlay row for a provider and type leaves it
  // listed, so delist it by hand.
  const scopes = [...new Map(rows.map((row) => [`${row.provider}/${row.type}`, row])).values()].map((row) => ({
    provider: row.provider,
    type: row.type,
  }));

  // Built from the same list so the two sides always line up.
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

    // Batched to stay under the Postgres parameter limit.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = await tx
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.provider, models.name, models.type],

          set: {
            ...Object.fromEntries(TRACKED.map((column) => [column, sql.raw(`excluded."${column}"`)])),
            updated_at: sql`now()`,
          },

          // Only write when something changed, so `updated_at` stays put. Tags
          // belong to operators and aren't compared.
          setWhere: sql`(${current}) IS DISTINCT FROM (${incoming})`,
        })
        .returning({ id: models.id });

      written += batch.length;
    }

    let delisted = 0;
    for (const scope of scopes) {
      const names = rows
        .filter((row) => row.provider === scope.provider && row.type === scope.type)
        .map((row) => row.name);

      // biome-ignore format: looks nicer
      const marked = await tx
        .update(models)
        .set({ delisted_at: sql`now()`, updated_at: sql`now()` })
        .where(and(
          eq(models.provider, scope.provider),
          eq(models.type, scope.type),
          notInArray(models.name, names),
          isNull(models.delisted_at)
        ))
        .returning({ id: models.id });

      delisted += marked.length;
    }

    // Mark everything still listed as seen. Uses the same scopes as delisting,
    // so a provider missing from this snapshot keeps its old synced_at. Runs
    // after delisting so just-delisted rows aren't confirmed.
    const inSnapshot = scopes.map((scope) => and(eq(models.provider, scope.provider), eq(models.type, scope.type)));

    // biome-ignore format: looks nicer
    const confirmed = await tx
      .update(models)
      .set({ synced_at: sql`now()` })
      .where(and(
        or(...inSnapshot),
        isNull(models.delisted_at)
      ))
      .returning({ id: models.id });

    logger.debug({ written, delisted: delisted, confirmed: confirmed.length }, 'Catalog upsert complete');

    return { written, delisted: delisted, confirmed: confirmed.length };
  });
}

/** Removes models from providers that aren't kept. */
export async function deleteExcludedModels(providerWhitelist: string[]): Promise<number> {
  // An empty list deletes everything, since drizzle turns notInArray(x, []) into 1 = 1.
  const deleted = await db
    .delete(models)
    .where(notInArray(models.provider, providerWhitelist))
    .returning({ id: models.id });
  return deleted.length;
}
