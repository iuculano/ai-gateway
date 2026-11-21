<script lang="ts">
import type { CatalogProvider } from '#lib/api/types.ts';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import Panel from '#lib/components/app/panel.svelte';
import { largestContext, priceRange, syncState } from '#lib/data/catalog.ts';
import { fmtContext, providerTone, timeAgo } from '#lib/data/format.ts';
import ModelTable from './model-table.svelte';

interface Props {
  /**
   * Already narrowed to the page's filters, so the counts describe what is
   * shown.
   */
  provider: CatalogProvider;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
}

let { provider, cols, expanded, ontoggle }: Props = $props();

const SYNC_TONES = {
  never: { label: 'Not synced', color: '#71717a', glow: 'transparent' },
  stale: { label: 'Stale', color: '#f59e0b', glow: 'rgba(245,158,11,.5)' },
  synced: { label: 'Synced', color: '#10b981', glow: 'rgba(16,185,129,.6)' },
};

const tone = $derived(providerTone(provider.id));
const models = $derived(provider.models);
const deprecatedCount = $derived(models.filter((model) => model.status === 'deprecated').length);
const unpricedCount = $derived(models.filter((model) => model.cost_input === null).length);
const inputRange = $derived(priceRange(models.map((model) => model.cost_input)));
const outputRange = $derived(priceRange(models.map((model) => model.cost_output)));
const maxContext = $derived(largestContext(models));
const sync = $derived(SYNC_TONES[syncState(provider.synced_at, Date.now())]);

const detailItems: DetailItem[] = $derived([
  { label: 'Provider id', value: provider.id },
  { label: 'Rows', value: String(models.length), mono: false },
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
		</span>

		<!-- Ranges and not an average, because what a caller wants from this row is
		     the floor and the ceiling of what a request to this provider can cost. -->
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
				<!-- Counted here and not shown as columns in the row above. These are
				     properties of the list, and they are what a reader is about to scan
				     for once the list is open. -->
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
