<script lang="ts">
import { onMount } from 'svelte';
import { listAuditLogs } from '#lib/api/audit-logs.ts';
import AutoRefreshToggle from '#lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import AuditRow from '#lib/components/audit/audit-row.svelte';
import { type AuditCategory, type AuditEvent, auditSummary, toAuditEvent } from '#lib/data/audit.ts';
import { AppendList } from '#lib/state/append-list.svelte.ts';
import { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';

type CatFilter = 'all' | AuditCategory;

const PAGE_SIZE = 50;

// Shared with AuditRow, so that the header and the rows sit in one grid. The
// Occurred column is as wide as the logs table's, which draws the same cell.
const COLS = '24px 150px minmax(110px,1fr) 84px minmax(150px,1.4fr) 104px 112px 86px';

const COLUMNS = [
  { label: '' },
  { label: 'Occurred' },
  { label: 'Actor' },
  { label: 'Actor type' },
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

// The categories keep their colours as dots inside the shared segmented
// control.
const TABS: { id: CatFilter; label: string; color?: string }[] = [{ id: 'all', label: 'All' }];

for (const [id, category] of Object.entries(CAT_META)) {
  TABS.push({ id: id as AuditCategory, label: category.label, color: category.color });
}

const auto = new AutoRefresh();

const list = new AppendList<AuditEvent>(fetchEvents, 'Failed to load the audit log.');

let cat: CatFilter = $state('all');
let expandedEvent: string | null = $state(null);

// Worked out over the events that are loaded, and not over the whole log.
const summary = $derived(auditSummary(list.rows, new Date()));

const filtered = $derived.by(() => {
  const query = dashboard.search.trim().toLowerCase();

  return list.rows.filter((event) => {
    if (cat !== 'all' && event.cat !== cat) {
      return false;
    }

    const searched = `${event.actorLabel} ${event.event} ${event.targetLabel || ''} ${event.ip}`.toLowerCase();

    return !query || searched.includes(query);
  });
});

async function fetchEvents(
  after?: string,
): Promise<{ data: AuditEvent[]; meta: Awaited<ReturnType<typeof listAuditLogs>>['meta'] }> {
  const page = await listAuditLogs({ limit: PAGE_SIZE, after_id: after });

  return { data: page.data.map(toAuditEvent), meta: page.meta };
}

$effect(() => auto.schedule(!list.appended, () => list.refresh()));

// Loaded once on mount and not in an effect, which would run again whenever
// the load changed its own state.
onMount(() => {
  void list.load();
});
</script>

<PageHeader
	title="Audit log"
	description="A chronological record of security and account activity across your organization."
/>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={list.loading}
	error={list.error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading audit log…"
	emptyTitle={list.rows.length === 0 ? 'No audit events recorded yet' : 'No events match your filters'}
	onretry={() => list.load()}
	showFooter={list.hasMore}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={cat} />
		<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
			<span class="font-medium text-zinc-100 tabular-nums">{filtered.length.toLocaleString()}</span>
			of <span class="font-medium text-zinc-200 tabular-nums">{list.rows.length.toLocaleString()}</span> events{list.hasMore ? ' loaded' : ''}
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-emerald-400 tabular-nums">{summary.today.toLocaleString()}</span> events today
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-blue-400 tabular-nums">{summary.actors.toLocaleString()}</span> active actors
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-red-400 tabular-nums">{summary.failures.toLocaleString()}</span> denied / flagged
		</span>

		<span class="ml-auto"></span>
		<AutoRefreshToggle {auto} active={!list.appended} pausedLabel="paused past page 1" />

		<RefreshButton disabled={list.loading} onclick={() => list.load()} />
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
		<ToolbarButton disabled={list.loadingMore} onclick={() => list.loadMore()}>
			{list.loadingMore ? 'Loading…' : 'Load older events'}
		</ToolbarButton>
	{/snippet}
</TableCard>
