<script lang="ts">
import { onMount } from 'svelte';
import { listAuditLogs } from '$lib/api/audit-logs';
import type { ListMeta } from '$lib/api/types';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import AuditRow from '$lib/components/audit/audit-row.svelte';
import { toAuditEvent } from '$lib/data/audit';
import type { AuditCategory, AuditEvent } from '$lib/data/types';
import { dashboard } from '$lib/state/dashboard.svelte';

type CatFilter = 'all' | AuditCategory;

const PAGE_SIZE = 50;

// Shared with AuditRow so the header and the rows sit in one grid.
const COLS = '24px 118px minmax(120px,1fr) minmax(150px,1.5fr) 104px 112px 86px';

const COLUMNS = [
  { label: '' },
  { label: 'Occurred' },
  { label: 'Actor' },
  { label: 'Action' },
  { label: 'Category' },
  { label: 'IP address' },
  { label: 'Status' },
];

const CAT_META: Record<AuditCategory, { label: string; color: string }> = {
  auth: { label: 'Authentication', color: '#60a5fa' },
  keys: { label: 'API Keys', color: '#10b981' },
  members: { label: 'Members', color: '#c084fc' },
  billing: { label: 'Billing', color: '#f59e0b' },
  settings: { label: 'Settings', color: '#94a3b8' },
  security: { label: 'Security', color: '#f87171' },
};

// The categories keep their colour coding as dots inside the shared segmented
// control - same shape as the other pages, without losing the signal.
const TABS: { id: CatFilter; label: string; color?: string }[] = [
  { id: 'all', label: 'All' },
  ...(Object.entries(CAT_META) as [AuditCategory, { label: string; color: string }][]).map(([id, meta]) => ({
    id,
    label: meta.label,
    color: meta.color,
  })),
];

let cat: CatFilter = $state('all');
let expandedEvent: string | null = $state(null);

let events: AuditEvent[] = $state([]);
let meta: ListMeta | null = $state(null);
let loading = $state(false);
let loadingMore = $state(false);
let error: string | null = $state(null);

async function load() {
  if (loading) return;
  loading = true;
  error = null;

  try {
    const result = await listAuditLogs({ limit: PAGE_SIZE });
    events = result.data.map(toAuditEvent);
    meta = result.meta;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load the audit log.';
  } finally {
    loading = false;
  }
}

async function loadMore() {
  if (loadingMore || !meta?.more_data || !meta.oldest_id) return;
  loadingMore = true;

  try {
    const result = await listAuditLogs({
      limit: PAGE_SIZE,
      after_id: meta.oldest_id,
    });
    events = [...events, ...result.data.map(toAuditEvent)];
    meta = result.meta;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load more events.';
  } finally {
    loadingMore = false;
  }
}

// Load once on mount - NOT $effect, which would re-run whenever the load
// mutates loading state and hammer the endpoint on any error.
onMount(() => {
  load();
});

// Summary stats are computed over the loaded window, not the whole table.
const todayIso = new Date().toISOString().slice(0, 10);
const eventsToday = $derived(events.filter((e) => e.createdAt.startsWith(todayIso)).length);
const activeActors = $derived(new Set(events.filter((e) => e.actorId).map((e) => e.actorId)).size);
const failures = $derived(events.filter((e) => e.status === 'failure').length);

const filtered = $derived.by(() => {
  const q = dashboard.search.trim().toLowerCase();
  return events.filter((e) => {
    if (cat !== 'all' && e.cat !== cat) return false;
    if (q && !`${e.actorName} ${e.action} ${e.targetLabel || ''} ${e.ip}`.toLowerCase().includes(q)) return false;
    return true;
  });
});
</script>

<PageHeader
	title="Audit log"
	description="A chronological record of security and account activity across your organization."
>
	{#snippet actions()}
		<ToolbarButton>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" /><path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			Last 7 days
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="ml-0.5"><path d="M5 6.5L8 9.5L11 6.5" stroke="#71717a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</ToolbarButton>
		<ToolbarButton>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Export
		</ToolbarButton>
	{/snippet}
</PageHeader>

<StatGrid>
	<StatCard label="Events today" value={eventsToday} accent="#10b981" />
	<StatCard label="Active actors" value={activeActors} accent="#60a5fa" />
	<StatCard label="Denied / flagged" value={failures} accent="#f87171" />
</StatGrid>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	{loading}
	{error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading audit log…"
	emptyTitle={events.length === 0 ? 'No audit events recorded yet' : 'No events match your filters'}
	onretry={load}
	showFooter={meta?.more_data ?? false}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={cat} />
		<span class="text-[12.5px] text-zinc-600">
			{filtered.length} of {events.length} events{meta?.more_data ? ' loaded' : ''}
		</span>
	{/snippet}

	{#each filtered as event (event.id)}
		<AuditRow
			{event}
			cols={COLS}
			catColor={CAT_META[event.cat].color}
			catLabel={CAT_META[event.cat].label}
			expanded={expandedEvent === event.id}
			ontoggle={() => (expandedEvent = expandedEvent === event.id ? null : event.id)}
		/>
	{/each}

	{#snippet footer()}
		<ToolbarButton disabled={loadingMore} onclick={loadMore}>
			{loadingMore ? 'Loading…' : 'Load older events'}
		</ToolbarButton>
	{/snippet}
</TableCard>
