<script lang="ts">
import ActivityIcon from '@lucide/svelte/icons/activity';
import BotIcon from '@lucide/svelte/icons/bot';
import ChartNoAxesGanttIcon from '@lucide/svelte/icons/chart-no-axes-gantt';
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
import CopyIcon from '@lucide/svelte/icons/copy';
import DatabaseIcon from '@lucide/svelte/icons/database';
import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
import WorkflowIcon from '@lucide/svelte/icons/workflow';
import WrenchIcon from '@lucide/svelte/icons/wrench';
import { onMount } from 'svelte';
import { page } from '$app/state';
import { getTrace, listTraces } from '$lib/api/traces';
import type { Trace, TraceDetail, TraceNode, TraceSource, TraceStatus } from '$lib/api/types';
import CardToolbar from '$lib/components/app/card-toolbar.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { fmt, fmtCost, fmtCostTotal, fmtLatency, fmtTokens, fmtTs } from '$lib/data/format';
import { dashboard } from '$lib/state/dashboard.svelte';

type TraceFilter = 'all' | 'errors' | 'slow';

const PAGE_SIZE = 25;

/** Above this, a run is worth surfacing on its own tab. */
const SLOW_THRESHOLD_MS = 8_000;

const FILTERS = [
  { id: 'all' as const, label: 'All traces' },
  { id: 'errors' as const, label: 'Errors', color: '#ef4444' },
  { id: 'slow' as const, label: 'Slow', color: '#f59e0b' },
];

const SOURCE_LABELS: Record<TraceSource, string> = {
  application_span: 'Application span',
  gateway_log: 'Gateway log',
  provider_attempt: 'Provider attempt',
};

const SOURCE_COLORS: Record<TraceSource, string> = {
  application_span: '#a78bfa',
  gateway_log: '#10b981',
  provider_attempt: '#38bdf8',
};

/**
 * One palette for the waterfall bars and the map.
 *
 * Colouring by source alone made a large agent run almost entirely violet - one
 * colour for nine tenths of the marks, which is the same as no colour. What
 * actually varies inside an application trace is kind, so that is what the
 * colour spends itself on.
 *
 * The two gateway-owned sources keep their own colours regardless of kind,
 * because that distinction is about trust rather than shape: a gateway log is
 * a record Relay stands behind, and it should not change appearance depending
 * on what the customer's span happened to be called.
 *
 * `custom` is deliberately the quiet one. Steps and outbound fetches are the
 * glue, and letting them recede is what makes the model and tool calls legible.
 */
const LEGEND_COLORS: Record<string, string> = {
  error: '#ef4444',
  workflow: '#a78bfa',
  llm: '#60a5fa',
  tool: '#fbbf24',
  retrieval: '#f472b6',
  embedding: '#22d3ee',
  rerank: '#c084fc',
  custom: '#8a8f98',
  gateway_log: SOURCE_COLORS.gateway_log,
  provider_attempt: SOURCE_COLORS.provider_attempt,
};

const LEGEND_LABELS: Record<string, string> = {
  error: 'Error',
  workflow: 'Workflow',
  llm: 'Model call',
  tool: 'Tool',
  retrieval: 'Retrieval',
  embedding: 'Embedding',
  rerank: 'Rerank',
  custom: 'Other',
  gateway_log: 'Gateway log',
  provider_attempt: 'Provider attempt',
};

const TICKS = [0, 0.25, 0.5, 0.75, 1];

let filter: TraceFilter = $state('all');
let traces = $state<Trace[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);

let selectedTraceId = $state<string | null>(null);
let detail = $state<TraceDetail | null>(null);
let detailLoading = $state(false);
let detailError = $state<string | null>(null);
let selectedNodeId = $state<string | null>(null);
let copied = $state(false);

/** Shown by default; the choice is kept as you move between traces. */
let showMap = $state(true);

/**
 * Loads the newest page of runs and opens the first of them.
 *
 * One page, no cursor: the waterfall beside the list is the point of this
 * screen, and paging the list is only worth adding once there is a time range
 * to page within.
 */
async function loadTraces(preferred?: string) {
  loading = true;
  error = null;

  try {
    const result = await listTraces({ limit: PAGE_SIZE });
    traces = result.data;

    // `preferred` wins over the newest run so a link from the logs table opens
    // the trace it named, and it is loaded by id rather than looked up in the
    // page above - the run may be far older than the twenty-five shown there.
    const first = preferred ?? result.data[0]?.trace_id;
    if (first) {
      await loadDetail(first);
    } else {
      selectedTraceId = null;
      detail = null;
    }

    error = null;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load traces.';
  } finally {
    loading = false;
  }
}

/**
 * Loads one run's waterfall.
 *
 * Every write checks that the trace it was started for is still the selected
 * one - clicking down a list faster than the requests come back would otherwise
 * leave whichever response landed last on screen.
 */
async function loadDetail(traceId: string) {
  selectedTraceId = traceId;
  detailLoading = true;
  detailError = null;

  try {
    const result = await getTrace(traceId);
    if (selectedTraceId !== traceId) return;

    detail = result;

    // Open on the first failure, which is what the run is being read for when
    // there is one.
    selectedNodeId = result.nodes.find((node) => node.status === 'error')?.id ?? result.nodes[0]?.id ?? null;
  } catch (err) {
    if (selectedTraceId !== traceId) return;

    detail = null;
    detailError = err instanceof Error ? err.message : 'Failed to load this trace.';
  } finally {
    if (selectedTraceId === traceId) {
      detailLoading = false;
    }
  }
}

// Load once on mount - NOT $effect, which would re-run on every state change
// the load itself makes.
onMount(() => {
  // The logs table links here with ?trace=<id> to follow one request back to
  // the run it belonged to.
  loadTraces(page.url.searchParams.get('trace') ?? undefined);
});

/** jsonb, so it arrives as an open object rather than as a typed map. */
function tagPairs(tags: unknown): [string, string][] {
  return Object.entries((tags ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)]);
}

const filteredTraces = $derived.by(() => {
  const query = dashboard.search.trim().toLowerCase();

  return traces.filter((trace) => {
    if (filter === 'errors' && trace.error_count === 0) return false;
    if (filter === 'slow' && (trace.duration_ms ?? 0) < SLOW_THRESHOLD_MS) return false;

    if (query) {
      const tags = tagPairs(trace.tags)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      const searchable = `${trace.name ?? ''} ${trace.trace_id} ${trace.status} ${tags}`.toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    return true;
  });
});

const nodes = $derived(detail?.nodes ?? []);
const selectedNode = $derived(nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null);

// Zero while a trace is still open and nothing has reported an end. Every
// reader of this guards against it rather than dividing by it.
const windowMs = $derived(detail?.trace.window_ms ?? 0);
const totalSpans = $derived(nodes.filter((node) => node.source === 'application_span').length);

// Computed over the page in view, and labelled as such - there is no aggregate
// endpoint for traces yet, and captioning 25 rows as '24h' would put an
// invented number in front of somebody reading it as one.
const failedTraces = $derived(traces.filter((trace) => trace.status === 'failed').length);
const successRate = $derived(traces.length === 0 ? null : ((traces.length - failedTraces) / traces.length) * 100);
const medianDuration = $derived.by(() => {
  const durations = traces
    .map((trace) => trace.duration_ms)
    .filter((duration): duration is number => duration !== null)
    .toSorted((left, right) => left - right);

  return durations[Math.floor(durations.length / 2)] ?? null;
});
const pageSpend = $derived(traces.reduce((sum, trace) => sum + Number(trace.total_cost), 0));
const pageTokens = $derived(
  traces.reduce((sum, trace) => sum + trace.total_input_tokens + trace.total_output_tokens, 0),
);

function traceStatusClass(status: TraceStatus): string {
  if (status === 'failed') return 'border-red-500/20 bg-red-500/10 text-red-400';
  if (status === 'partial') return 'border-amber-500/20 bg-amber-500/10 text-amber-400';
  return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
}

function traceStatusDot(status: TraceStatus): string {
  if (status === 'failed') return '#ef4444';
  if (status === 'partial') return '#f59e0b';
  return '#10b981';
}

/**
 * Only an error is worth colouring differently.
 *
 * 'unset' is not a warning: OpenTelemetry defaults every span to it and the
 * specification discourages setting OK explicitly, so almost every real
 * application span arrives unset. Colouring those amber painted a healthy run
 * as though half of it had gone wrong. Detail that genuinely has not arrived is
 * what the trace's 'Partial detail' badge is for.
 */
/**
 * Which key entry a node belongs to.
 *
 * Colour and legend both come from this, so the two cannot drift apart - an
 * errored span is counted under Error because that is how it is drawn.
 */
function nodeKey(node: TraceNode): string {
  if (node.status === 'error') return 'error';
  return node.source === 'application_span' ? node.kind : node.source;
}

function nodeColor(node: TraceNode): string {
  return LEGEND_COLORS[nodeKey(node)] ?? LEGEND_COLORS.custom;
}

function nodeLeft(node: TraceNode): number {
  if (windowMs === 0) return 0;
  return Math.min(100, (node.start_offset_ms / windowMs) * 100);
}

function nodeWidth(node: TraceNode): number {
  if (windowMs === 0) return 1.2;

  const left = nodeLeft(node);
  return Math.max(1.2, Math.min(100 - left, (node.duration_ms / windowMs) * 100));
}

/** One row per depth level, in the map's own coordinate space. */
const MAP_ROW = 8;

const mapDepth = $derived(nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0) + 1);
const mapHeight = $derived(mapDepth * MAP_ROW);

/**
 * The whole run at a glance: time across, nesting down.
 *
 * Drawn in a fixed 1000-unit width and stretched to whatever the card is,
 * because the only thing that has to be accurate is the proportions. A span
 * lasting a few milliseconds inside a three-minute trace would round to nothing,
 * so every one is given a minimum width - the point is that no work is invisible.
 */
/**
 * The key, built from what this trace actually contains.
 *
 * Provider attempts are kept even at zero: the node contract has them, Relay
 * does not emit them yet, and an entry reading 0 says that far better than a
 * silently missing row would.
 */
const legend = $derived.by(() => {
  const counts = new Map<string, number>([['provider_attempt', 0]]);

  for (const node of nodes) {
    const key = nodeKey(node);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      label: LEGEND_LABELS[key] ?? key,
      color: LEGEND_COLORS[key] ?? LEGEND_COLORS.custom,
    }))
    .sort((left, right) => right.count - left.count);
});

function mapLeft(node: TraceNode): number {
  return windowMs === 0 ? 0 : (node.start_offset_ms / windowMs) * 1000;
}

function mapWidth(node: TraceNode): number {
  if (windowMs === 0) return 1;

  return Math.max(0.9, Math.min(1000 - mapLeft(node), (node.duration_ms / windowMs) * 1000));
}

/**
 * Arrow keys walk the waterfall; selection follows focus.
 *
 * Tab already reaches every row - they are buttons - but reaching one is not
 * the same as reading it, so focusing a row selects it. That makes the detail
 * panel and the map's highlight track the keyboard without a second keystroke.
 *
 * The rows are found through the DOM rather than kept in an array of bindings.
 * With a keyed each and a list replaced wholesale every time another trace is
 * opened, an index-keyed ref array is a stale-entry bug waiting to happen, and
 * the siblings are right there.
 */
function moveFocus(event: KeyboardEvent): void {
  const current = event.currentTarget;
  if (!(current instanceof HTMLButtonElement)) return;

  const rows = [...(current.parentElement?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? [])];
  const index = rows.indexOf(current);
  if (index === -1) return;

  const target =
    event.key === 'ArrowDown'
      ? index + 1
      : event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : -1;

  if (target < 0 || target >= rows.length || target === index) return;

  // Otherwise the arrow key scrolls the container as well as moving focus, and
  // the row lands somewhere other than where the scroll left it.
  event.preventDefault();
  rows[target]?.focus();
}

async function copyTraceId() {
  if (!detail) return;

  try {
    await navigator.clipboard.writeText(detail.trace.trace_id);
    copied = true;
    window.setTimeout(() => (copied = false), 1_500);
  } catch {
    copied = false;
  }
}
</script>

<svelte:head>
	<title>Traces · Relay</title>
	<meta
		name="description"
		content="Inspect application runs across model calls, tools, retrievals, gateway logs, and provider attempts."
	/>
</svelte:head>

<PageHeader
	title="Traces"
	description="Follow one application run across model calls, tools, retrievals, and provider attempts."
>
	{#snippet actions()}
		<ToolbarButton disabled={loading} onclick={() => loadTraces()}>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Refresh
		</ToolbarButton>
		<ToolbarButton>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Export
		</ToolbarButton>
	{/snippet}
</PageHeader>

<StatGrid>
	<StatCard label="Traces · page" value={fmt(traces.length)} hint={failedTraces > 0 ? `${failedTraces} failed` : undefined} />
	<StatCard
		label="Success rate · page"
		value={successRate === null ? '—' : `${successRate.toFixed(1)}%`}
		accent={successRate !== null && successRate >= 99 ? '#10b981' : undefined}
	/>
	<StatCard label="Median duration · page" value={fmtLatency(medianDuration)} />
	<StatCard label="Trace spend · page" value={fmtCostTotal(pageSpend)} hint="{fmt(pageTokens)} tok" />
</StatGrid>

<div class="grid items-start gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
	<section class="overflow-hidden rounded-xl border border-track bg-surface-1" aria-label="Trace list">
		<CardToolbar>
			<FilterTabs tabs={FILTERS} bind:value={filter} equalWidth />
		</CardToolbar>

		<div class="flex min-h-10 items-center justify-between border-b border-line px-4 text-[11px] text-zinc-600">
			<span>{filteredTraces.length} of {traces.length} on this page</span>
			<span class="tracking-[.05em] uppercase">Newest first</span>
		</div>

		<div class="max-h-[680px] overflow-y-auto">
			{#if loading && traces.length === 0}
				<div class="px-5 py-12 text-center text-[13px] text-zinc-500">Loading traces…</div>
			{:else if error}
				<div class="px-5 py-12 text-center">
					<div class="text-[13px] text-red-400">{error}</div>
					<button
						type="button"
						class="mt-3 rounded-md border border-line-strong bg-surface-3 px-2.5 py-1 text-[11.5px] text-zinc-300 hover:bg-surface-4"
						onclick={() => loadTraces()}
					>
						Retry
					</button>
				</div>
			{:else if filteredTraces.length === 0}
				<div class="px-5 py-12 text-center">
					<div class="text-[13px] text-zinc-400">
						{traces.length === 0 ? 'No traces recorded yet' : 'No traces match'}
					</div>
					<div class="mt-1 text-xs text-zinc-600">
						{traces.length === 0
							? 'Export application spans to /v1/traces to see runs here.'
							: 'Try another filter or clear search.'}
					</div>
				</div>
			{:else}
				{#each filteredTraces as trace (trace.id)}
					<button
						type="button"
						aria-pressed={trace.trace_id === selectedTraceId}
						class="group relative w-full border-b border-line px-4 py-3.5 text-left last:border-b-0 {trace.trace_id ===
						selectedTraceId
							? 'bg-surface-5'
							: 'hover:bg-surface-3'}"
						onclick={() => loadDetail(trace.trace_id)}
					>
						{#if trace.trace_id === selectedTraceId}
							<span class="absolute inset-y-3 left-0 w-0.5 rounded-r bg-emerald-500"></span>
						{/if}

						<div class="flex items-start gap-3">
							<span
								class="mt-[5px] size-2 flex-none rounded-full shadow-[0_0_0_3px_var(--color-surface-5)]"
								style:background={traceStatusDot(trace.status)}
							></span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate text-[13px] font-medium text-zinc-200">{trace.name ?? 'Unnamed run'}</span>
									<ChevronRightIcon class="ml-auto size-3.5 flex-none text-zinc-700 group-hover:text-zinc-500" />
								</div>
								<div class="mt-1 font-mono text-[10.5px] text-zinc-600">{trace.trace_id.slice(0, 16)}…</div>
								<div class="mt-2.5 flex items-center gap-2 text-[11.5px] text-zinc-500">
									<span>{fmtTs(trace.started_at).time}</span>
									<span class="text-zinc-800">•</span>
									<span class="tabular-nums">{fmtLatency(trace.duration_ms)}</span>
									<span class="text-zinc-800">•</span>
									<span>{trace.log_count} calls</span>
									{#if trace.error_count > 0}
										<span class="ml-auto font-medium text-red-400">{trace.error_count} {trace.error_count === 1 ? 'error' : 'errors'}</span>
									{/if}
								</div>
							</div>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	</section>

	<section class="min-w-0 overflow-hidden rounded-xl border border-track bg-surface-1" aria-label="Trace detail">
		{#if detailError}
			<div class="px-5 py-16 text-center">
				<div class="text-[13px] text-red-400">{detailError}</div>
				{#if selectedTraceId}
					<button
						type="button"
						class="mt-3 rounded-md border border-line-strong bg-surface-3 px-2.5 py-1 text-[11.5px] text-zinc-300 hover:bg-surface-4"
						onclick={() => selectedTraceId && loadDetail(selectedTraceId)}
					>
						Retry
					</button>
				{/if}
			</div>
		{:else if !detail}
			<div class="px-5 py-16 text-center text-[13px] text-zinc-500">
				{detailLoading || loading ? 'Loading trace…' : 'Select a trace to see its waterfall.'}
			</div>
		{:else}
			<header>
				<CardToolbar>
					<div
						class="grid w-full gap-3 lg:grid-cols-[minmax(240px,0.9fr)_1px_minmax(0,1.6fr)] lg:items-stretch lg:gap-4 xl:h-8 xl:grid-cols-[minmax(260px,1fr)_1px_minmax(0,1.45fr)]"
					>
						<div class="flex min-w-0 items-center gap-3 lg:self-center xl:h-8">
						<div
							class="flex size-9 flex-none items-center justify-center rounded-[9px] border border-violet-400/15 bg-violet-400/8 text-violet-300 xl:size-8"
						>
							<WorkflowIcon class="size-4" />
						</div>
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-1.5 xl:flex-nowrap">
								<h2 class="min-w-[6rem] truncate text-[15px] leading-4 font-semibold text-zinc-100 xl:flex-auto">{detail.trace.name ?? 'Unnamed run'}</h2>
								<span
									class="flex-none rounded-md border px-1.5 py-px text-[10px] leading-3 font-medium capitalize {traceStatusClass(
										detail.trace.status,
									)}"
								>
									{detail.trace.status}
								</span>
								{#if detail.trace.detail_status === 'partial'}
									<span class="flex-none rounded-md border border-amber-500/20 bg-amber-500/8 px-1.5 py-px text-[10px] leading-3 text-amber-400">
										Partial detail
									</span>
								{/if}
								{#each tagPairs(detail.trace.tags) as [key, value] (key)}
									<span class="min-w-0 truncate rounded-md border border-line-strong bg-surface-3 px-1.5 py-px text-[10px] leading-3 text-zinc-500">{key}={value}</span>
								{/each}
							</div>
							<div class="flex h-4 items-center gap-1.5 font-mono text-[10.5px] leading-3 text-zinc-600">
								<span class="truncate">{detail.trace.trace_id}</span>
								<button
									type="button"
									class="flex size-4 flex-none items-center justify-center rounded text-zinc-600 hover:bg-surface-5 hover:text-zinc-300"
									aria-label="Copy trace ID"
									onclick={copyTraceId}
								>
									<CopyIcon class="size-2.5" />
								</button>
								{#if copied}<span class="font-sans text-[10.5px] text-emerald-500">Copied</span>{/if}
							</div>
							</div>
						</div>

						<div class="h-px w-full bg-line lg:h-auto lg:w-px"></div>

						<div
							class="grid grid-cols-2 content-center gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-[minmax(90px,1.5fr)_repeat(5,minmax(44px,1fr))] xl:gap-x-3 xl:gap-y-0"
						>
						<div>
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Started</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 text-zinc-300" title={detail.trace.started_at}>{fmtTs(detail.trace.started_at).full}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Duration</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 font-medium text-zinc-200 tabular-nums">{fmtLatency(detail.trace.duration_ms)}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Model calls</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 font-medium text-zinc-200">{detail.trace.log_count}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Tools</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 font-medium text-zinc-200">{detail.trace.tool_count}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Tokens</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 font-medium text-zinc-200 tabular-nums">{fmtTokens(detail.trace.total_input_tokens + detail.trace.total_output_tokens)}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-[10.5px] leading-3 tracking-[.04em] text-zinc-600 uppercase">Cost</div>
							<div class="mt-0.5 truncate text-[12px] leading-4 font-medium text-zinc-200 tabular-nums">{fmtCost(Number(detail.trace.total_cost))}</div>
						</div>
						</div>
					</div>
				</CardToolbar>
			</header>

			<div class="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-1.5">
				<span class="text-[10.5px] font-medium tracking-[.04em] text-zinc-600 uppercase">Waterfall</span>
				{#each legend as entry (entry.key)}
					<div class="flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-zinc-500">
						<span class="size-1.5 rounded-[1px]" style:background={entry.color}></span>
						{entry.label}
						<span class="text-zinc-700 tabular-nums">{entry.count}</span>
					</div>
				{/each}
				<div class="ml-auto flex items-center gap-3">
					<span class="text-[10.5px] text-zinc-600">{totalSpans} application spans</span>
					<button
						type="button"
						aria-pressed={showMap}
						class="flex h-6 items-center gap-1.5 rounded-md border px-2 text-[10.5px] {showMap
							? 'border-violet-400/20 bg-violet-400/10 text-violet-300'
							: 'border-line-strong bg-surface-3 text-zinc-400 hover:bg-surface-4 hover:text-zinc-200'}"
						onclick={() => (showMap = !showMap)}
					>
						<ChartNoAxesGanttIcon class="size-3" />
						Toggle Map
					</button>
				</div>
			</div>

			{#if showMap && nodes.length > 0}
				<!-- The whole run in eighty pixels: time across, nesting down, one mark
				     per span. For a three-hundred-span agent run the waterfall below can
				     only ever show a window; this is the shape of the thing. -->
				<div class="border-b border-line bg-surface-2 px-5 py-3">
					<svg
						viewBox="0 0 1000 {mapHeight}"
						preserveAspectRatio="none"
						class="block w-full"
						style:height={`${mapHeight}px`}
						role="img"
						aria-label="Overview of {nodes.length} spans across {mapDepth} levels of nesting"
					>
						{#each nodes as node (node.id)}
							<rect
								x={mapLeft(node)}
								y={node.depth * MAP_ROW}
								width={mapWidth(node)}
								height={MAP_ROW - 2}
								rx="0.8"
								fill={nodeColor(node)}
								opacity={selectedNode?.id === node.id ? 1 : 0.72}
								stroke={selectedNode?.id === node.id ? '#fafafa' : 'none'}
								stroke-width="1.5"
								vector-effect="non-scaling-stroke"
							>
								<title>{node.name} · {fmtLatency(node.duration_ms)}</title>
							</rect>
						{/each}
					</svg>

					<div class="mt-2 flex flex-wrap items-center gap-x-2 text-[10.5px] text-zinc-600">
						<span class="tabular-nums">{nodes.length} nodes</span>
						<span class="text-zinc-800">•</span>
						<span class="tabular-nums">{mapDepth} levels deep</span>
						<span class="text-zinc-800">•</span>
						<span class="tabular-nums">{fmtLatency(windowMs)} end to end</span>
					</div>
				</div>
			{/if}

			<div class="overflow-x-auto">
				<div class="min-w-[760px]">
					<div class="grid min-h-10 grid-cols-[250px_minmax(340px,1fr)_72px] items-center border-b border-line bg-surface-2 px-4">
						<span class="text-[10.5px] font-medium tracking-[.04em] text-zinc-600 uppercase">Operation</span>
						<div class="relative h-4">
							{#each TICKS as tick (tick)}
								<span
									class="absolute -translate-x-1/2 text-[10px] text-zinc-700 first:translate-x-0 last:-translate-x-full"
									style:left={`${tick * 100}%`}
								>
									{fmtLatency(windowMs * tick)}
								</span>
							{/each}
						</div>
						<span class="text-right text-[10.5px] font-medium tracking-[.04em] text-zinc-600 uppercase">Time</span>
					</div>

					<!-- Scrolls inside the card rather than moving the page: a long agent run is
					     dozens of spans, and the axis the bars are measured against sits above
					     this, so scrolling the whole page would take it off screen. -->
					<div class="max-h-[clamp(260px,40vh,620px)] overflow-y-auto">
					{#if nodes.length === 0}
						<div class="px-5 py-12 text-center">
							<div class="text-[13px] text-zinc-400">Nothing to draw for this run</div>
							<div class="mt-1 text-xs text-zinc-600">No application spans or gateway calls are correlated to it.</div>
						</div>
					{/if}

					{#each nodes as node (node.id)}
						<button
							type="button"
							aria-pressed={selectedNode?.id === node.id}
							class="grid w-full grid-cols-[250px_minmax(340px,1fr)_72px] items-center border-b border-line px-4 py-2 text-left last:border-b-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-violet-400/70 {selectedNode?.id ===
							node.id
								? 'bg-surface-5/80'
								: 'hover:bg-surface-3'}"
							onclick={() => (selectedNodeId = node.id)}
							onfocus={() => (selectedNodeId = node.id)}
							onkeydown={moveFocus}
						>
							<div class="flex min-w-0 items-center gap-2" style:padding-left={`${node.depth * 14}px`}>
								<span class="flex size-5 flex-none items-center justify-center text-zinc-600">
									{#if node.kind === 'workflow'}
										<WorkflowIcon class="size-3.5" />
									{:else if node.kind === 'tool'}
										<WrenchIcon class="size-3.5" />
									{:else if node.kind === 'retrieval'}
										<DatabaseIcon class="size-3.5" />
									{:else if node.source === 'provider_attempt'}
										<ActivityIcon class="size-3.5" />
									{:else}
										<BotIcon class="size-3.5" />
									{/if}
								</span>
								<div class="min-w-0">
									<div class="flex items-center gap-1.5">
										<span class="truncate text-[11.5px] {node.status === 'error' ? 'text-red-300' : 'text-zinc-300'}">
											{node.name}
										</span>
										{#if node.status === 'error'}<CircleAlertIcon class="size-3 flex-none text-red-400" />{/if}
									</div>
									<div class="mt-0.5 text-[9.5px] text-zinc-700">{SOURCE_LABELS[node.source]}</div>
								</div>
							</div>

							<div class="relative h-7 overflow-hidden rounded-[5px] bg-surface-2">
								{#each TICKS as tick (tick)}
									<span
										class="absolute inset-y-0 w-px bg-line"
										style:left={`${tick * 100}%`}
									></span>
								{/each}
								<span
									class="absolute top-[5px] h-[18px] min-w-[3px] rounded-[4px] opacity-85 shadow-[0_0_0_1px_rgba(255,255,255,.08)_inset]"
									style={`left:${nodeLeft(node)}%;width:${nodeWidth(node)}%;background:${nodeColor(node)}`}
								></span>
							</div>

							<span class="text-right text-[11px] text-zinc-500 tabular-nums">{fmtLatency(node.duration_ms)}</span>
						</button>
					{/each}
					</div>
				</div>
			</div>

			{#if selectedNode}
				<div class="border-t border-line bg-surface-2 px-5 py-4">
					<div class="mb-3 flex min-h-6 flex-wrap items-center gap-2">
						<span class="text-[11px] font-medium tracking-[.05em] text-zinc-600 uppercase">Selected node</span>
						<span class="text-[12px] font-medium text-zinc-300">{selectedNode.name}</span>
						<span
							class="rounded-md border border-line-strong bg-surface-3 px-1.5 py-0.5 text-[10px] text-zinc-500"
						>
							{SOURCE_LABELS[selectedNode.source]}
						</span>
						<div class="ml-auto flex h-6 min-w-[132px] items-center justify-end">
							{#if selectedNode.log_id}
								<a
									href="/logs"
									class="flex h-6 items-center gap-1.5 rounded-md border border-line-strong bg-surface-3 px-2 text-[10.5px] text-zinc-400 hover:bg-surface-4 hover:text-zinc-200"
								>
									Open gateway log
									<ExternalLinkIcon class="size-3" />
								</a>
							{/if}
						</div>
					</div>

					<div class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 2xl:grid-cols-6">
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Span ID</div>
							<div class="mt-1 truncate font-mono text-[10.5px] text-zinc-400">{selectedNode.id}</div>
						</div>
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Start offset</div>
							<div class="mt-1 text-[11.5px] text-zinc-400 tabular-nums">+{fmtLatency(selectedNode.start_offset_ms)}</div>
						</div>
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Duration</div>
							<div class="mt-1 text-[11.5px] text-zinc-400 tabular-nums">{fmtLatency(selectedNode.duration_ms)}</div>
						</div>
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Model / provider</div>
							<div class="mt-1 truncate text-[11.5px] text-zinc-400">
								{selectedNode.model ?? '—'}{selectedNode.provider ? ` · ${selectedNode.provider}` : ''}
							</div>
						</div>
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Tokens</div>
							<div class="mt-1 text-[11.5px] text-zinc-400 tabular-nums">
								{selectedNode.input_tokens === null && selectedNode.output_tokens === null
									? '—'
									: `${fmtTokens(selectedNode.input_tokens ?? 0)} in · ${fmtTokens(selectedNode.output_tokens ?? 0)} out`}
							</div>
						</div>
						<div>
							<div class="text-[10px] tracking-[.04em] text-zinc-700 uppercase">Cost</div>
							<div class="mt-1 text-[11.5px] text-zinc-400 tabular-nums">
								{selectedNode.cost === null ? '—' : fmtCost(Number(selectedNode.cost))}
							</div>
						</div>
					</div>

					{#if tagPairs(selectedNode.attributes).length > 0}
						<div class="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
							{#each tagPairs(selectedNode.attributes) as [key, value] (key)}
								<span class="rounded-md border border-line bg-surface-1 px-2 py-1 font-mono text-[10px] text-zinc-500">
									<span class="text-zinc-700">{key}=</span>{value}
								</span>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</section>
</div>
