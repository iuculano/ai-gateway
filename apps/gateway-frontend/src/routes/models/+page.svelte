<script lang="ts">
import { onMount } from 'svelte';
import { listProviders } from '$lib/api/models';
import type { CatalogProvider } from '$lib/api/types';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import ProviderRow from '$lib/components/models/provider-row.svelte';
import { timeAgo } from '$lib/data/format';

type SourceFilter = 'all' | 'builtin' | 'custom';

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

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'builtin' as const, label: 'Built-in' },
  { id: 'custom' as const, label: 'Custom' },
];

// Local state rather than a store in $lib/state. Those exist for pages whose
// tables feed each other or whose rows are edited; this is one read-only table
// behind one unpaginated request, and a store would only add indirection.
let providers: CatalogProvider[] = $state([]);
let loading = $state(true);
let error: string | null = $state(null);

let sourceFilter: SourceFilter = $state('all');
let expandedProvider: string | null = $state(null);
let search = $state('');

async function load() {
  loading = true;
  error = null;

  try {
    const result = await listProviders();
    providers = result.data;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Failed to load the catalogue.';
  } finally {
    loading = false;
  }
}

// Once on mount, not in an $effect - an effect would re-run on the state the
// load itself mutates and hammer the endpoint on any error.
onMount(load);

/**
 * Providers, with their model lists narrowed to the current filter.
 *
 * Filtering the models rather than the providers is what keeps the table
 * provider-focused: switching to Custom should show which providers hold custom
 * rows, not replace the provider list with a list of models.
 */
const filtered = $derived.by(() => {
  const query = search.trim().toLowerCase();

  return providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => {
        if (sourceFilter !== 'all' && model.source !== sourceFilter) return false;
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
const customCount = $derived(allModels.filter((model) => model.source === 'custom').length);
const unpricedCount = $derived(allModels.filter((model) => model.cost_input === null).length);
const shownCount = $derived(filtered.reduce((total, provider) => total + provider.models.length, 0));

/** The oldest sync across providers - the figure that says the catalogue is stale. */
const lastSynced = $derived.by(() => {
  const stamps = providers.map((provider) => provider.synced_at).filter((stamp): stamp is string => stamp !== null);
  if (stamps.length === 0) return null;
  return stamps.reduce((oldest, stamp) => (stamp < oldest ? stamp : oldest));
});
</script>

<PageHeader
	title="Models"
	description="The catalogue the gateway prices and routes against, synced hourly from models.dev."
/>

<StatGrid>
	<StatCard label="Providers" value={providers.length} />
	<StatCard label="Models" value={allModels.length} hint={customCount > 0 ? `${customCount} custom` : undefined} />
	<!-- Surfaced rather than buried: an unpriced model is one that bills at
	     nothing, and the count belongs where it cannot be missed. -->
	<StatCard
		label="Unpriced"
		value={unpricedCount}
		hint="of {allModels.length}"
		accent={unpricedCount > 0 ? '#f59e0b' : undefined}
	/>
	<StatCard
		label="Last synced"
		value={lastSynced ? timeAgo(lastSynced) : '—'}
		hint={lastSynced ? 'from models.dev' : undefined}
	/>
</StatGrid>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	{loading}
	{error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading catalogue…"
	emptyTitle={providers.length === 0 ? 'No providers in the catalogue' : 'No providers match your filters'}
	emptyHint={providers.length === 0 ? 'The catalogue worker populates this on its first sync.' : undefined}
	onretry={load}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={sourceFilter} />
		<input
			type="search"
			placeholder="Search providers and models…"
			bind:value={search}
			class="h-8 w-64 rounded-lg border border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-line-strong focus:outline-none"
		/>
		<span class="text-[12.5px] text-zinc-600">{shownCount} of {allModels.length} models</span>
		<div class="ml-auto flex items-center gap-2.5">
			<ToolbarButton onclick={load} disabled={loading}>
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
</TableCard>
