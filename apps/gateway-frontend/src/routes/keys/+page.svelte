<script lang="ts">
import { untrack } from 'svelte';
import AutoRefreshToggle from '$lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import CreateKeyDialog from '$lib/components/keys/create-key-dialog.svelte';
import KeyRow from '$lib/components/keys/key-row.svelte';
import { AutoRefresh } from '$lib/state/auto-refresh.svelte';
import { dashboard } from '$lib/state/dashboard.svelte';

type StatusFilter = 'all' | 'active' | 'expired' | 'revoked';

// Shared with KeyRow so the header and the rows sit in one grid.
const COLS = '24px 1.5fr 88px 1.5fr 1fr 90px 84px 136px';

const COLUMNS = [
  { label: '' },
  { label: 'Name' },
  { label: 'Scopes' },
  { label: 'Description' },
  { label: 'Created' },
  { label: 'Requests', align: 'right' as const },
  { label: 'Status' },
  { label: 'Actions', align: 'right' as const },
];

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'active' as const, label: 'Active', color: '#10b981' },
  { id: 'expired' as const, label: 'Expired', color: '#f59e0b' },
  { id: 'revoked' as const, label: 'Revoked', color: '#f87171' },
];

let statusFilter: StatusFilter = $state('all');
let expandedKey: string | null = $state(null);
let createOpen = $state(false);

const auto = new AutoRefresh();

$effect(() => auto.schedule(dashboard.pageIndex === 0, () => dashboard.refreshQuietly()));

$effect(() => {
  dashboard.pageIndex;
  expandedKey = null;
});

$effect(() => {
  const status = statusFilter;
  untrack(() => {
    expandedKey = null;
    void dashboard.filterByStatus(status);
  });
});

function displayCount(status: StatusFilter): string {
  const result = dashboard.counts[status];
  return result ? `${result.estimated ? '~' : ''}${result.count.toLocaleString()}` : '—';
}

const filteredKeys = $derived.by(() => {
  const q = dashboard.search.trim().toLowerCase();
  return dashboard.keys.filter((k) => {
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

<TableCard
	showFooter={dashboard.pageIndex > 0 || (dashboard.meta?.more_data ?? false)}
	cols={COLS}
	columns={COLUMNS}
	loading={dashboard.loading && dashboard.keys.length === 0}
	error={dashboard.error}
	isEmpty={filteredKeys.length === 0}
	loadingLabel="Loading keys…"
	emptyTitle={dashboard.keys.length === 0 && dashboard.pageIndex === 0 && statusFilter === 'all' ? 'No API keys yet' : 'No keys match on this page'}
	emptyHint={dashboard.keys.length === 0 && dashboard.pageIndex === 0 && statusFilter === 'all' ? 'Create your first key to start calling the Relay API.' : undefined}
	onretry={() => dashboard.refresh()}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={statusFilter} />
		<span class="text-[12.5px] text-zinc-400">
			<span class="inline-grid text-right font-medium text-zinc-200 tabular-nums">
				<!-- Reserve the current page size so filtering does not move the counts. -->
				<span class="invisible col-start-1 row-start-1" aria-hidden="true">{dashboard.keys.length}</span>
				<span class="col-start-1 row-start-1">{filteredKeys.length}</span>
			</span> of
			<span class="font-medium text-zinc-200 tabular-nums">{displayCount(statusFilter)}</span> matching keys
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-emerald-400 tabular-nums">{displayCount('active')}</span> active
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-amber-400 tabular-nums">{displayCount('expired')}</span> expired
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-red-400 tabular-nums">{displayCount('revoked')}</span> revoked
		</span>
		{#if Object.values(dashboard.countErrors).some(Boolean)}
			<ToolbarButton onclick={() => dashboard.refreshCounts()}>Retry counts</ToolbarButton>
		{/if}
		<!-- One right-hand group: the automatic and the manual refresh belong
		     beside each other, and a plain block wrapper stacked them. -->
		<div class="ml-auto flex items-center gap-2.5">
			<AutoRefreshToggle {auto} active={dashboard.pageIndex === 0} pausedLabel="paused past page 1" />
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
	{#snippet footer()}
		<div class="flex items-center justify-center gap-3">
			<ToolbarButton disabled={dashboard.pageIndex === 0 || dashboard.loading} onclick={() => dashboard.previousPage()}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 4L6 8l3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Newer
			</ToolbarButton>
			<span class="min-w-[64px] text-center text-[12.5px] text-zinc-500">Page {dashboard.pageIndex + 1}</span>
			<ToolbarButton disabled={!dashboard.meta?.more_data || dashboard.loading} onclick={() => dashboard.nextPage()}>
				Older
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 4L10 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</ToolbarButton>
		</div>
	{/snippet}
</TableCard>

<CreateKeyDialog bind:open={createOpen} />
