<script lang="ts">
import { onMount } from 'svelte';
import { listProviders } from '$lib/api/models';
import type { CatalogProvider } from '$lib/api/types';
import PageHeader from '$lib/components/app/page-header.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import ProviderRow from '$lib/components/models/provider-row.svelte';
import { timeAgo } from '$lib/data/format';

const PAGE_SIZE = 20;

// Shared with ProviderRow so the header and the rows sit in one grid.
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

let providers: CatalogProvider[] = $state([]);
let loading = $state(true);
let error: string | null = $state(null);
let meta: Awaited<ReturnType<typeof listProviders>>['meta'] | null = $state(null);
let pageIndex = $state(0);
let cursors: string[] = $state([]);
let requestId = 0;

let expandedProvider: string | null = $state(null);
let search = $state('');

async function load({ index = pageIndex }: { index?: number } = {}) {
  const request = ++requestId;
  loading = true;
  error = null;

  try {
    const after = index === 0 ? undefined : cursors[index - 1];
    const result = await listProviders({ limit: PAGE_SIZE, after_id: after });
    if (request !== requestId) return;

    providers = result.data;
    meta = result.meta;
    pageIndex = index;
    expandedProvider = null;
  } catch (cause) {
    if (request !== requestId) return;
    error = cause instanceof Error ? cause.message : 'Failed to load the catalog.';
  } finally {
    if (request === requestId) loading = false;
  }
}

function nextPage() {
  if (!meta?.more_data || !meta.oldest_id || loading) return;
  cursors = [...cursors.slice(0, pageIndex), meta.oldest_id];
  load({ index: pageIndex + 1 });
}

function previousPage() {
  if (pageIndex === 0 || loading) return;
  load({ index: pageIndex - 1 });
}

onMount(() => {
  load();
});

/** Filter the catalog by provider or model name. */
const filtered = $derived.by(() => {
  const query = search.trim().toLowerCase();

  return providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => {
        if (query && !provider.id.toLowerCase().includes(query)) {
          return (
            model.name.toLowerCase().includes(query) || (model.display_name?.toLowerCase().includes(query) ?? false)
          );
        }
        return true;
      }),
    }))
    .filter((provider) => provider.models.length > 0);
});

const allModels = $derived(providers.flatMap((provider) => provider.models));
const unpricedCount = $derived(allModels.filter((model) => model.cost_input === null).length);
const shownCount = $derived(filtered.reduce((total, provider) => total + provider.models.length, 0));

/** The oldest sync across providers - the figure that says the catalog is stale. */
const lastSynced = $derived.by(() => {
  const stamps = providers.map((provider) => provider.synced_at).filter((stamp): stamp is string => stamp !== null);
  if (stamps.length === 0) return null;
  return stamps.reduce((oldest, stamp) => (stamp < oldest ? stamp : oldest));
});
</script>

<PageHeader
	title="Models"
	description="The model catalog and published prices, synced hourly from models.dev."
/>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	{loading}
	{error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading catalog…"
	emptyTitle={providers.length === 0 ? 'No providers in the catalog' : 'No providers match your filters'}
	emptyHint={providers.length === 0 ? 'The catalog worker populates this on its first sync.' : undefined}
	onretry={() => load()}
	showFooter={pageIndex > 0 || (meta?.more_data ?? false)}
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
			<span class="font-medium text-zinc-200 tabular-nums">{providers.length.toLocaleString()}</span> providers on this page
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium tabular-nums {unpricedCount > 0 ? 'text-amber-400' : 'text-zinc-200'}">{unpricedCount.toLocaleString()}</span> unpriced
			<span class="mx-1 text-zinc-600">·</span>
			last synced <span
				class="font-medium tabular-nums {lastSynced ? (Date.now() - new Date(lastSynced).getTime() > 3 * 60 * 60 * 1000 ? 'text-amber-400' : 'text-emerald-400') : 'text-zinc-600'}"
				title={lastSynced ? `From models.dev · ${lastSynced}` : undefined}
			>{lastSynced ? timeAgo(lastSynced) : '—'}</span>
		</span>
		<div class="ml-auto flex items-center gap-2.5">
			<ToolbarButton onclick={() => load()} disabled={loading}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Refresh
			</ToolbarButton>
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
		<div class="flex items-center justify-center gap-3">
			<ToolbarButton disabled={pageIndex === 0 || loading} onclick={previousPage}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 4L6 8l3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Previous
			</ToolbarButton>
			<span class="min-w-[64px] text-center text-[12.5px] text-zinc-500">Page {pageIndex + 1}</span>
			<ToolbarButton disabled={!meta?.more_data || loading} onclick={nextPage}>
				Next
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 4L10 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</ToolbarButton>
		</div>
	{/snippet}
</TableCard>
