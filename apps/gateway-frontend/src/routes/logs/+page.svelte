<script lang="ts">
import { onMount } from 'svelte';
import { getLogStats, listLogs } from '$lib/api/logs';
import type { Log, LogListMeta } from '$lib/api/types';
import AutoRefreshToggle from '$lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import type { PayloadView } from '$lib/components/logs/log-row.svelte';
import LogRow from '$lib/components/logs/log-row.svelte';
import { AutoRefresh } from '$lib/state/auto-refresh.svelte';
import { dashboard } from '$lib/state/dashboard.svelte';

type StatusFilter = 'all' | 'complete' | 'failed' | 'incomplete';

const PAGE_SIZE = 20;

// Shared with LogRow so the header and the rows sit in one grid.
const COLS =
  '24px 150px minmax(104px,0.7fr) minmax(140px,1.4fr) 96px 100px 76px 100px 96px 104px 100px 92px 84px 180px';

const COLUMNS = [
  { label: '' },
  { label: 'Timestamp' },
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
  { id: 'failed' as const, label: 'Errors', color: '#f87171' },
];

const VIEW_TABS = [
  { id: 'simple' as const, label: 'Simple' },
  { id: 'json' as const, label: 'JSON' },
];

let tab: StatusFilter = $state('all');
let expandedLog: string | null = $state(null);

// Set from the toolbar and read by every row, so the choice holds as the reader
// moves between rows. Defaults to the conversation, which is what the panel is
// being opened to see most of the time; JSON is one click away when it isn't.
let payloadView: PayloadView = $state('simple');
const auto = new AutoRefresh();

let logs: Log[] = $state([]);
let stats: Awaited<ReturnType<typeof getLogStats>> | null = $state(null);
let statsError = $state(false);

async function refreshStats() {
  try {
    stats = await getLogStats();
    statsError = false;
  } catch {
    stats = null;
    statsError = true;
  }
}

function displayCount(count: number | undefined) {
  return count === undefined ? '—' : `${stats?.estimated ? '~' : ''}${count.toLocaleString()}`;
}

let meta: LogListMeta | null = $state(null);
let loading = $state(false);
let error: string | null = $state(null);

/** Zero-based. Page 0 is the newest logs and is the only one auto-refresh tails. */
let pageIndex = $state(0);

/**
 * The `after_id` cursor that fetches each page past the first: cursors[i] opens
 * page i + 1. Page 0 needs none, being the head of the list.
 *
 * A stack rather than a single cursor, because this endpoint is cursor-paged
 * and cursors only walk one step. Keeping the ones already used is what lets
 * Previous go back without re-walking from the top.
 *
 * Every fetch is therefore a FORWARD scan, including the ones that move
 * backwards through the pages. That matters for more than tidiness: `more_data`
 * reports whether the scan direction has more rows, so paging backwards with
 * `before_id` would leave it answering "are there newer logs" at the exact
 * moment Next needs to know whether there are older ones.
 */
let cursors: string[] = $state([]);
let requestId = 0;

function setStatus(value: StatusFilter) {
  tab = value;
  pageIndex = 0;
  cursors = [];
  meta = null;
  expandedLog = null;
  load({ index: 0 });
}

const matchingCount = $derived.by(() => (tab === 'all' ? stats?.total : stats?.by_status[tab]));

/**
 * Loads one page.
 *
 * `silent` is what the auto-refresh timer uses: it leaves `loading` alone so
 * the table keeps showing the rows it has instead of blanking to a spinner
 * every few seconds.
 */
async function load({ index = pageIndex, silent = false }: { index?: number; silent?: boolean } = {}) {
  const request = ++requestId;

  if (!silent) {
    loading = true;
    error = null;
  }

  try {
    const after = index === 0 ? undefined : cursors[index - 1];
    const result = await listLogs({ limit: PAGE_SIZE, after_id: after, status: tab === 'all' ? undefined : tab });

    if (request !== requestId) return;
    logs = result.data;
    meta = result.meta;
    pageIndex = index;
    error = null;

    // Collapse any open row: the id it belonged to is not on this page.
    if (!silent) {
      expandedLog = null;
    }
  } catch (err) {
    if (request !== requestId) return;
    const message = err instanceof Error ? err.message : 'Failed to load logs.';

    // A background refresh that fails must not throw away the rows the reader
    // is looking at, and must not retry into the same failure every few
    // seconds. Rethrown so AutoRefresh keeps the stale data, says so once, and
    // switches itself off.
    if (silent && logs.length > 0) {
      throw err instanceof Error ? err : new Error(message);
    }

    error = message;
  } finally {
    if (request === requestId) loading = false;
  }
}

/**
 * Steps one page older.
 *
 * The cursor is recorded at the index it opens before the fetch, and the tail
 * beyond it is dropped - paging forward from a page reached by going back
 * invalidates whatever was recorded past it.
 */
function nextPage() {
  if (!meta?.more_data || !meta.oldest_id || loading) return;

  cursors = [...cursors.slice(0, pageIndex), meta.oldest_id];
  load({ index: pageIndex + 1 });
}

function previousPage() {
  if (pageIndex === 0 || loading) return;
  load({ index: pageIndex - 1 });
}

// Load once on mount - NOT $effect, which would re-run whenever the load
// mutates loading state and hammer the endpoint on any error.
onMount(() => {
  load();
  refreshStats();
});

// The timer lives in an $effect purely so its cleanup runs on both halves of
// the switch: toggling it off tears the interval down, and so does leaving the
// page. A bare setInterval would keep firing after navigation.
//
// Gated to page 0, which is the only page new logs can arrive on - cursors are
// ids and every new log takes a higher one, so a later page returns the same
// rows however much traffic lands meanwhile. Ticking there would spend a request
// per interval to redraw identical data. Reading pageIndex here also
// re-subscribes the effect, so the timer restarts on the page that needs it.
$effect(() => auto.schedule(pageIndex === 0, () => load({ silent: true })));

const filtered = $derived.by(() => {
  const q = dashboard.search.trim().toLowerCase();
  return logs.filter((l) => {
    if (q && !`${l.model} ${l.provider} ${l.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
});
</script>

<PageHeader
	title="Logs"
	description="Every model request routed through Relay, with full request and response payloads."
/>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	{loading}
	{error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading logs…"
	emptyTitle={logs.length === 0 ? 'No logs recorded yet' : 'No logs match your filters'}
	onretry={() => load()}
	showFooter={pageIndex > 0 || (meta?.more_data ?? false)}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={() => tab, setStatus} />
		<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
      <span class="inline-grid text-right font-medium text-zinc-100 tabular-nums">
        <span class="invisible col-start-1 row-start-1" aria-hidden="true">{logs.length}</span>
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

		<AutoRefreshToggle {auto} active={pageIndex === 0} pausedLabel="paused off page 1" />

		<ToolbarButton disabled={loading} onclick={() => { load(); refreshStats(); }}>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Refresh
		</ToolbarButton>
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
		<div class="flex items-center justify-center gap-3">
			<ToolbarButton disabled={pageIndex === 0 || loading} onclick={previousPage}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 4L6 8l3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Newer
			</ToolbarButton>

			<!-- 'Page N', not 'Page N of M'. The endpoint is cursor-paged and there
			     is no count, so a total would have to be invented. -->
			<span class="min-w-[64px] text-center text-[12.5px] text-zinc-500">Page {pageIndex + 1}</span>

			<ToolbarButton disabled={!meta?.more_data || loading} onclick={nextPage}>
				Older
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 4L10 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</ToolbarButton>
		</div>
	{/snippet}
</TableCard>
