<script lang="ts">
import { untrack } from 'svelte';
import type { ApiKeyStatus } from '#lib/api/api-keys.ts';
import AutoRefreshToggle from '#lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import Pager from '#lib/components/app/pager.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import CreateKeyDialog from '#lib/components/keys/create-key-dialog.svelte';
import KeyRow from '#lib/components/keys/key-row.svelte';
import { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';

// Shared with KeyRow, so that the header and the rows sit in one grid.
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

const auto = new AutoRefresh();
const keys = dashboard.keys;

let statusFilter: ApiKeyStatus = $state('all');
let expandedKey: string | null = $state(null);
let createOpen = $state(false);

const filteredKeys = $derived.by(() => {
  const query = dashboard.search.trim().toLowerCase();

  return keys.rows.filter((key) => !query || key.name.toLowerCase().includes(query));
});

$effect(() => auto.schedule(keys.pageIndex === 0, () => keys.refresh()));

// A row that was open belongs to the page it was on.
$effect(() => {
  void keys.pageIndex;
  expandedKey = null;
});

$effect(() => {
  const status = statusFilter;

  // Only the filter is tracked. The load reads state of its own, and tracking
  // that would run this again for every page it loaded.
  untrack(() => {
    expandedKey = null;
    void dashboard.filterByStatus(status);
  });
});

/**
 * How many keys have a status, with an estimate marked as one.
 */
function displayCount(status: ApiKeyStatus): string {
  const result = dashboard.counts[status];

  return result ? `${result.estimated ? '~' : ''}${result.count.toLocaleString()}` : '—';
}
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
	showFooter={keys.pageIndex > 0 || keys.hasMore}
	cols={COLS}
	columns={COLUMNS}
	loading={keys.loading && keys.rows.length === 0}
	error={keys.error}
	isEmpty={filteredKeys.length === 0}
	loadingLabel="Loading keys…"
	emptyTitle={keys.rows.length === 0 && keys.pageIndex === 0 && statusFilter === 'all' ? 'No API keys yet' : 'No keys match on this page'}
	emptyHint={keys.rows.length === 0 && keys.pageIndex === 0 && statusFilter === 'all' ? 'Create your first key to start calling the Relay API.' : undefined}
	onretry={() => dashboard.refresh()}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={statusFilter} />
		<span class="text-[12.5px] text-zinc-400">
			<span class="inline-grid text-right font-medium text-zinc-200 tabular-nums">
				<!-- Reserve the current page size so filtering does not move the counts. -->
				<span class="invisible col-start-1 row-start-1" aria-hidden="true">{keys.rows.length}</span>
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
		<!-- One group on the right, because the automatic and the manual refresh
		     belong beside each other and a plain block wrapper stacked them. -->
		<div class="ml-auto flex items-center gap-2.5">
			<AutoRefreshToggle {auto} active={keys.pageIndex === 0} pausedLabel="paused past page 1" />
			<RefreshButton onclick={() => dashboard.refresh()} />
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
		<Pager list={keys} />
	{/snippet}
</TableCard>

<CreateKeyDialog bind:open={createOpen} />
