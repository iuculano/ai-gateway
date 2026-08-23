<script lang="ts">
import type { CatalogModel, CatalogProvider } from '$lib/api/types';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import { fmtContext, fmtPricePerMillion, providerTone, timeAgo } from '$lib/data/format';
import ModelTable from './model-table.svelte';

let {
  provider,
  cols,
  expanded,
  ontoggle,
}: {
  /** Already narrowed to the page's filters - the counts below describe what is shown. */
  provider: CatalogProvider;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
} = $props();

// Known providers get their display name and brand colour locally; everything
// else falls back to a generated label and neutral colour.
const tone = $derived(providerTone(provider.id));

const models = $derived(provider.models);
const builtinCount = $derived(models.filter((model) => model.source === 'builtin').length);
const customCount = $derived(models.filter((model) => model.source === 'custom').length);
const deprecatedCount = $derived(models.filter((model) => model.status === 'deprecated').length);
const unpricedCount = $derived(models.filter((model) => model.cost_input === null).length);

/**
 * The span of published input and output prices across a provider's models.
 *
 * Unpriced models are excluded rather than counted as zero, which would drag
 * every range down to '$0.00 – …' the moment one image model appeared.
 */
function priceRange(pick: (model: CatalogModel) => number | null): string {
  const values = models.map(pick).filter((value): value is number => value !== null);
  if (values.length === 0) return 'Unpriced';

  const low = Math.min(...values);
  const high = Math.max(...values);

  return low === high ? fmtPricePerMillion(low) : `${fmtPricePerMillion(low)} – ${fmtPricePerMillion(high)}`;
}

const inputRange = $derived(priceRange((model) => model.cost_input));
const outputRange = $derived(priceRange((model) => model.cost_output));

const maxContext = $derived(
  models.reduce<number | null>((best, model) => Math.max(best ?? 0, model.context_limit ?? 0) || null, null),
);

/**
 * Freshness of this provider's built-in rows.
 *
 * Stale at three hours - the worker polls hourly, so one missed tick is noise
 * and three is a worker that has stopped. A provider holding only custom rows
 * has never been synced and is not stale, it is simply not the worker's.
 */
const sync = $derived.by(() => {
  if (provider.synced_at === null) {
    return { label: 'Local only', color: '#71717a', glow: 'transparent' };
  }

  const age = Date.now() - new Date(provider.synced_at).getTime();
  return age > 3 * 60 * 60 * 1000
    ? { label: 'Stale', color: '#f59e0b', glow: 'rgba(245,158,11,.5)' }
    : { label: 'Synced', color: '#10b981', glow: 'rgba(16,185,129,.6)' };
});

const detailItems: DetailItem[] = $derived([
  { label: 'Provider id', value: provider.id },
  { label: 'Rows', value: `${builtinCount} built-in · ${customCount} custom`, mono: false },
  { label: 'Unpriced', value: `${unpricedCount} of ${models.length}`, mono: false },
]);
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<span class="size-[7px] flex-none rounded-full" style:background={tone.color}></span>
			<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{tone.label}</span>
		</span>

		<span class="text-[12.5px] whitespace-nowrap text-zinc-500 tabular-nums">
			{models.length}
			{#if customCount > 0}
				<span class="text-zinc-600">· {customCount} custom</span>
			{/if}
		</span>

		<!-- Ranges rather than an average: what a caller wants from this row is the
		     floor and the ceiling of what a request to this provider can cost. -->
		<span class="text-[13px] whitespace-nowrap text-zinc-400 tabular-nums">{inputRange}</span>
		<span class="text-[13px] whitespace-nowrap text-zinc-400 tabular-nums">{outputRange}</span>
		<span class="text-[13px] text-zinc-400 tabular-nums">{fmtContext(maxContext)}</span>

		<span class="text-[13px] whitespace-nowrap text-zinc-400" title={provider.synced_at ?? undefined}>
			{provider.synced_at === null ? '—' : timeAgo(provider.synced_at)}
		</span>

		<span class="inline-flex items-center gap-1.5 text-xs font-medium" style:color={sync.color}>
			<span class="size-1.5 rounded-full" style:background={sync.color} style:box-shadow="0 0 6px {sync.glow}"
			></span>{sync.label}
		</span>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={4} />

		<Panel title="Models">
			{#snippet actions()}
				<!-- Counted here rather than shown as columns in the row above: these
				     are properties of the list, and they are what a reader is about to
				     scan for once the list is open. -->
				<span class="text-[11.5px] text-zinc-600">
					{models.length} total
					{#if deprecatedCount > 0}
						· <span class="text-amber-500/80">{deprecatedCount} deprecated</span>
					{/if}
					{#if unpricedCount > 0}
						· <span class="text-zinc-500">{unpricedCount} unpriced</span>
					{/if}
				</span>
			{/snippet}

			<ModelTable {models} />
		</Panel>
	{/snippet}
</ExpandableRow>
