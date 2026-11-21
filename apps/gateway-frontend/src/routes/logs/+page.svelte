<script lang="ts">
import { onMount } from 'svelte';
import { countLogs, listLogs } from '#lib/api/logs.ts';
import type { Log, LogListMeta } from '#lib/api/types.ts';
import AutoRefreshToggle from '#lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import Pager from '#lib/components/app/pager.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import LogRow, { type PayloadView } from '#lib/components/logs/log-row.svelte';
import { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';
import { PagedList } from '#lib/state/paged-list.svelte.ts';

type StatusFilter = 'all' | 'complete' | 'failed' | 'incomplete';

const PAGE_SIZE = 20;

// Shared with LogRow, so that the header and the rows sit in one grid.
const COLS =
  '24px 150px 84px minmax(104px,0.7fr) minmax(140px,1.4fr) 96px 100px 76px 100px 96px 104px 100px 92px 84px 180px';

const COLUMNS = [
  { label: '' },
  { label: 'Timestamp' },
  { label: 'Operation' },
  { label: 'Provider' },
  { label: 'Model' },
  { label: 'Trace' },
  { label: 'Status' },
  { label: 'Cache hit', align: 'right' as const },
  { label: 'Cached tokens', align: 'right' as const },
  { label: 'Input tokens', align: 'right' as const },
  { label: 'Output tokens', align: 'right' as const },
  { label: 'Throughput', align: 'right' as const },
  { label: 'Cost', align: 'right' as const },
  { label: 'Latency', align: 'right' as const },
  { label: 'Actions', align: 'right' as const },
];

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'complete' as const, label: 'Success', color: '#34d399' },
  { id: 'incomplete' as const, label: 'Incomplete', color: '#fbbf24' },
  { id: 'failed' as const, label: 'Failed', color: '#f87171' },
];

const VIEW_TABS = [
  { id: 'simple' as const, label: 'Simple' },
  { id: 'json' as const, label: 'JSON' },
];

const auto = new AutoRefresh();

let tab: StatusFilter = $state('all');
let expandedLog: string | null = $state(null);

// Set from the toolbar and read by every row, so that the choice holds as the
// reader moves between rows. It opens on the conversation, which is what a row
// is opened to see most of the time.
let payloadView: PayloadView = $state('simple');

let stats = $state<Awaited<ReturnType<typeof countLogs>> | null>(null);
let statsError = $state(false);

const list = new PagedList<Log, LogListMeta>(
  (after) => listLogs({ limit: PAGE_SIZE, after_id: after, status: tab === 'all' ? undefined : tab }),
  'Failed to load logs.',
);

const matchingCount = $derived(tab === 'all' ? stats?.total : stats?.by_status[tab]);

const filtered = $derived.by(() => {
  const query = dashboard.search.trim().toLowerCase();

  return list.rows.filter((log) => !query || `${log.model} ${log.provider} ${log.id}`.toLowerCase().includes(query));
});

async function refreshStats(): Promise<void> {
  try {
    stats = await countLogs();
    statsError = false;
  } catch {
    stats = null;
    statsError = true;
  }
}

/**
 * A count for the toolbar, with an estimate marked as one.
 */
function displayCount(count: number | undefined): string {
  return count === undefined ? '—' : `${stats?.estimated ? '~' : ''}${count.toLocaleString()}`;
}

function setStatus(value: StatusFilter): void {
  tab = value;
  expandedLog = null;

  void list.restart();
}

function reload(): void {
  void list.load();
  void refreshStats();
}

async function tail(): Promise<void> {
  // The counts look after their own failures, so that they cannot stop the
  // rows from being tailed.
  await Promise.all([list.refresh(), refreshStats()]);
}

// A row that was open belongs to the page it was on.
$effect(() => {
  void list.pageIndex;
  expandedLog = null;
});

// Only the first page is tailed, because it is the only one new logs can
// arrive on. Ids only grow, so a later page returns the same rows however much
// traffic lands in the meantime.
$effect(() => auto.schedule(list.pageIndex === 0, tail));

// Loaded once on mount and not in an effect, which would run again whenever
// the load changed its own state.
onMount(reload);
</script>

<PageHeader
	title="Logs"
	description="Every model request routed through Relay, with full request and response payloads."
/>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={list.loading || list.pending}
	error={list.error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading logs…"
	emptyTitle={list.rows.length === 0 ? 'No logs recorded yet' : 'No logs match your filters'}
	onretry={() => list.load()}
	showFooter={list.pageIndex > 0 || list.hasMore}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={() => tab, setStatus} />
		<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
      <span class="inline-grid text-right font-medium text-zinc-100 tabular-nums">
        <span class="invisible col-start-1 row-start-1" aria-hidden="true">{list.rows.length}</span>
        <span class="col-start-1 row-start-1">{filtered.length}</span>
      </span>
      of <span class="font-medium text-zinc-200 tabular-nums">{displayCount(matchingCount)}</span> matching logs
      <span class="mx-1 text-zinc-600">·</span>
      <span class="font-medium text-emerald-400 tabular-nums">{displayCount(stats?.by_status.complete)}</span> success
      <span class="mx-1 text-zinc-600">·</span>
      <span class="font-medium text-amber-400 tabular-nums">{displayCount(stats?.by_status.incomplete)}</span> incomplete
      <span class="mx-1 text-zinc-600">·</span>
      <span class="font-medium text-red-400 tabular-nums">{displayCount(stats?.by_status.failed)}</span> failed
      {#if dashboard.search.trim()}<span class="text-zinc-600">(page filtered)</span>{/if}
    </span>
    {#if statsError}
      <ToolbarButton onclick={refreshStats}>Retry counts</ToolbarButton>
    {/if}
		<span class="ml-auto flex items-center gap-2 text-[12.5px] text-zinc-500">
			<FilterTabs tabs={VIEW_TABS} bind:value={payloadView} />
		</span>

		<AutoRefreshToggle {auto} active={list.pageIndex === 0} pausedLabel="paused off page 1" />

		<RefreshButton disabled={list.loading} onclick={reload} />
	{/snippet}

	{#each filtered as log (log.id)}
		<LogRow
			{log}
			cols={COLS}
			expanded={expandedLog === log.id}
			ontoggle={() => (expandedLog = expandedLog === log.id ? null : log.id)}
			view={payloadView}
		/>
	{/each}

	{#snippet footer()}
		<Pager list={list} />
	{/snippet}
</TableCard>
