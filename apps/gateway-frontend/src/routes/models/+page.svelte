<script lang="ts">
import { onMount } from 'svelte';
import { listProviders } from '#lib/api/models.ts';
import PageHeader from '#lib/components/app/page-header.svelte';
import Pager from '#lib/components/app/pager.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ProviderRow from '#lib/components/models/provider-row.svelte';
import { oldestSync, searchCatalog, syncState } from '#lib/data/catalog.ts';
import { timeAgo } from '#lib/data/format.ts';
import { PagedList } from '#lib/state/paged-list.svelte.ts';

const PAGE_SIZE = 20;

// Shared with ProviderRow, so that the header and the rows sit in one grid.
const COLS = '24px 1.7fr 118px 1.1fr 1.1fr 104px 92px 96px';

const COLUMNS = [
  { label: '' },
  { label: 'Provider' },
  { label: 'Models' },
  { label: 'Input $/M' },
  { label: 'Output $/M' },
  { label: 'Max context' },
  { label: 'Synced' },
  { label: 'Status' },
];

const SYNC_CLASSES = { never: 'text-zinc-600', stale: 'text-amber-400', synced: 'text-emerald-400' };

const list = new PagedList(
  (after) => listProviders({ limit: PAGE_SIZE, after_id: after }),
  'Failed to load the catalog.',
);

let expandedProvider: string | null = $state(null);
let search = $state('');

const filtered = $derived(searchCatalog(list.rows, search));
const allModels = $derived(list.rows.flatMap((provider) => provider.models));
const unpricedCount = $derived(allModels.filter((model) => model.cost_input === null).length);
const shownCount = $derived(filtered.reduce((total, provider) => total + provider.models.length, 0));
const lastSynced = $derived(oldestSync(list.rows));

// A row that was open belongs to the page it was on.
$effect(() => {
  void list.pageIndex;
  expandedProvider = null;
});

onMount(() => {
  void list.load();
});
</script>

<PageHeader
	title="Models"
	description="The model catalog and published prices, synced hourly from models.dev."
/>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={list.loading || list.pending}
	error={list.error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading catalog…"
	emptyTitle={list.rows.length === 0 ? 'No providers in the catalog' : 'No providers match your filters'}
	emptyHint={list.rows.length === 0 ? 'The catalog worker populates this on its first sync.' : undefined}
	onretry={() => list.load()}
	showFooter={list.pageIndex > 0 || list.hasMore}
>
	{#snippet toolbar()}
		<input
			type="search"
			placeholder="Search this page…"
			bind:value={search}
			class="h-8 w-64 rounded-lg border border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-line-strong focus:outline-none"
		/>
		<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
			<span class="font-medium text-zinc-100 tabular-nums">{shownCount.toLocaleString()}</span>
			of <span class="font-medium text-zinc-200 tabular-nums">{allModels.length.toLocaleString()}</span> models
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-zinc-200 tabular-nums">{list.rows.length.toLocaleString()}</span> providers on this page
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium tabular-nums {unpricedCount > 0 ? 'text-amber-400' : 'text-zinc-200'}">{unpricedCount.toLocaleString()}</span> unpriced
			<span class="mx-1 text-zinc-600">·</span>
			last synced <span
				class="font-medium tabular-nums {SYNC_CLASSES[syncState(lastSynced, Date.now())]}"
				title={lastSynced ? `From models.dev · ${lastSynced}` : undefined}
			>{lastSynced ? timeAgo(lastSynced) : '—'}</span>
		</span>
		<div class="ml-auto flex items-center gap-2.5">
			<RefreshButton onclick={() => list.load()} disabled={list.loading} />
		</div>
	{/snippet}

	{#each filtered as provider (provider.id)}
		<ProviderRow
			{provider}
			cols={COLS}
			expanded={expandedProvider === provider.id}
			ontoggle={() => (expandedProvider = expandedProvider === provider.id ? null : provider.id)}
		/>
	{/each}
	{#snippet footer()}
		<Pager list={list} previousLabel="Previous" nextLabel="Next" />
	{/snippet}
</TableCard>
