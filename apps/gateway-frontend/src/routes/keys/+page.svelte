<script lang="ts">
import { onMount } from 'svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import CreateKeyDialog from '$lib/components/keys/create-key-dialog.svelte';
import KeyRow from '$lib/components/keys/key-row.svelte';
import { dashboard } from '$lib/state/dashboard.svelte';

type StatusFilter = 'all' | 'active';

// Shared with KeyRow so the header and the rows sit in one grid.
const COLS = '24px 1.8fr 1.6fr 1fr 90px 84px 136px';

const COLUMNS = [
  { label: '' },
  { label: 'Name' },
  { label: 'Description' },
  { label: 'Created' },
  { label: 'Requests', align: 'right' as const },
  { label: 'Status' },
  { label: 'Actions', align: 'right' as const },
];

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'active' as const, label: 'Active' },
];

let statusFilter: StatusFilter = $state('all');
let expandedKey: string | null = $state(null);
let createOpen = $state(false);

// Load once on mount - NOT $effect, which would re-run whenever the load
// mutates dashboard.loading and hammer the endpoint on any error.
onMount(() => {
  dashboard.ensureLoaded();
});

const activeCount = $derived(dashboard.keys.filter((k) => k.revoked_at === null).length);

const filteredKeys = $derived.by(() => {
  const q = dashboard.search.trim().toLowerCase();
  return dashboard.keys.filter((k) => {
    if (statusFilter === 'active' && k.revoked_at !== null) return false;
    if (q && !k.name.toLowerCase().includes(q)) return false;
    return true;
  });
});
</script>

<PageHeader title="API Keys" description="Manage secret keys used to authenticate requests to the Relay API.">
	{#snippet actions()}
		<ToolbarButton variant="primary" onclick={() => (createOpen = true)}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 3.3v9.4M3.3 8h9.4" stroke="#04130d" stroke-width="1.8" stroke-linecap="round" /></svg>
			Create key
		</ToolbarButton>
	{/snippet}
</PageHeader>

<StatGrid>
	<StatCard label="Total keys" value={dashboard.keys.length} />
	<StatCard label="Active keys" value={activeCount} hint="/ {dashboard.keys.length} total">
		{#if dashboard.keys.length > 0}
			<div class="mt-2.5 flex gap-1">
				{#each dashboard.keys as k (k.id)}
					<span class="h-1 flex-1 rounded-sm {k.revoked_at === null ? 'bg-emerald-500' : 'bg-zinc-800'}"></span>
				{/each}
			</div>
		{/if}
	</StatCard>
</StatGrid>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={dashboard.loading && dashboard.keys.length === 0}
	error={dashboard.error}
	isEmpty={filteredKeys.length === 0}
	loadingLabel="Loading keys…"
	emptyTitle={dashboard.keys.length === 0 ? 'No API keys yet' : 'No keys match your filters'}
	emptyHint={dashboard.keys.length === 0 ? 'Create your first key to start calling the Relay API.' : undefined}
	onretry={() => dashboard.refresh()}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={statusFilter} />
		<span class="text-[12.5px] text-zinc-600">{filteredKeys.length} of {dashboard.keys.length} keys</span>
		<div class="ml-auto">
			<ToolbarButton onclick={() => dashboard.refresh()}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Refresh
			</ToolbarButton>
		</div>
	{/snippet}

	{#each filteredKeys as apiKey (apiKey.id)}
		<KeyRow
			{apiKey}
			cols={COLS}
			expanded={expandedKey === apiKey.id}
			ontoggle={() => (expandedKey = expandedKey === apiKey.id ? null : apiKey.id)}
		/>
	{/each}
</TableCard>

<CreateKeyDialog bind:open={createOpen} />
