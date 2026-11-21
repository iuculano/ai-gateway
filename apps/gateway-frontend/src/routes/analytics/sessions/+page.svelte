<script lang="ts">
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
import {
  fetchSeries,
  fetchSessionDistribution,
  fetchSessionPositions,
  fetchSessions,
  type SeriesPoint,
  type SessionDistributionResponse,
} from '#lib/api/analytics.ts';
import { listLogs } from '#lib/api/logs.ts';
import { getAnalyticsFilters, windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import ChartCard from '#lib/components/app/chart-card.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import StatCard from '#lib/components/app/stat-card.svelte';
import StatGrid from '#lib/components/app/stat-grid.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { Input } from '#lib/components/ui/input/index.ts';
import { fmt, fmtClock, fmtCost, fmtElapsed, fmtPercent, fmtSpend, providerTone } from '#lib/data/format.ts';
import { percentileRank } from '#lib/data/percentiles.ts';
import {
  binPositions,
  costBand,
  costGrowth,
  heavySessions,
  type Position,
  participants,
  requestBand,
  type Session,
  type SessionSort,
  sessionMeasure,
  sessionSpread,
} from '#lib/data/sessions.ts';
import { AppendList } from '#lib/state/append-list.svelte.ts';
import { Latest } from '#lib/state/latest.svelte.ts';
import { goto } from '$app/navigation';
import { page } from '$app/state';

// Sessions from the session_id tag, laid out like the Users tab. The list is on
// the left and everyone's figures, or one session's, on the right.
//
// Figures cover the selected window, so a session that started before it shows
// only its part inside it. The picked session lives in ?session=.

const ACCENT = '#10b981';
const INPUT_INK = '#60a5fa';
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';

// Sessions per page of the list, and requests per page of one session's list.
const PAGE = 50;
const REQUEST_PAGE = 50;

// Past this many positions the chart groups them.
const MAX_BARS = 60;

// The chart's drawing area.
const HEIGHT = 190;
const PAD = { top: 14, right: 46, bottom: 24, left: 50 };
const plotHeight = HEIGHT - PAD.top - PAD.bottom;

type SessionLog = Awaited<ReturnType<typeof listLogs>>['data'][number];

const filters = getAnalyticsFilters();
const days = $derived(filters.range.days);
const sessionId = $derived(page.url.searchParams.get('session') ?? undefined);

// The list

let sort = $state<SessionSort>('spend');
const sorts = [
  { id: 'spend', label: 'Spend' },
  { id: 'requests', label: 'Requests' },
  { id: 'length', label: 'Length' },
] satisfies { id: SessionSort; label: string }[];

interface SessionList {
  sessions: Session[];
  count: number;

  /**
   * The window the list was loaded for. Later pages reuse it, so that a page
   * fetched after the window moves on cannot skip or repeat sessions.
   */
  range: { start_date: string; end_date: string };
}

const list = new Latest<SessionList>();
let loadingMore = $state(false);

async function fetchList(): Promise<SessionList> {
  const range = windowOf(days);
  const response = await fetchSessions({ ...range, limit: PAGE, sort: sort });

  return { sessions: response.top, count: response.count, range: range };
}

function loadList(): void {
  void list.load(fetchList);
}

/**
 * Adds the next page of sessions to the end of the list.
 */
async function loadMore(): Promise<void> {
  const shown = list.value;

  if (!shown) {
    return;
  }

  loadingMore = true;

  try {
    const response = await fetchSessions({ ...shown.range, limit: PAGE, offset: shown.sessions.length, sort: sort });

    // A list loaded again in the meantime has no place for this page.
    if (list.value === shown) {
      list.value = { ...shown, sessions: [...shown.sessions, ...response.top] };
    }
  } catch {
    // The list keeps what it has and the button stays, so it can be tried
    // again.
  } finally {
    loadingMore = false;
  }
}

$effect(() => {
  void [days, sort];
  loadList();
});

const listLoading = $derived(list.loading);
const listFailed = $derived(list.error !== null);
const sessions = $derived(list.value?.sessions ?? []);
const sessionCount = $derived(list.value?.count ?? null);

const topMeasure = $derived(sessions[0] ? sessionMeasure(sessions[0], sort) : 0);
const unlisted = $derived(sessionId !== undefined && !sessions.some((session) => session.session_id === sessionId));

/**
 * This tab's URL with a session picked, or with everyone.
 */
function sessionsHref(id: string | null): string {
  return id ? `/analytics/sessions?session=${encodeURIComponent(id)}` : '/analytics/sessions';
}

let lookup = $state('');

function openSession(event: SubmitEvent): void {
  event.preventDefault();

  const id = lookup.trim();
  if (id) {
    void goto(sessionsHref(id), { reset: false });
  }
}

// Everyone's spread, which is also what one session is compared against

const spreadOfAll = new Latest<SessionDistributionResponse>();

function fetchDistribution(): Promise<SessionDistributionResponse> {
  return fetchSessionDistribution(windowOf(days));
}

function loadDistribution(): void {
  void spreadOfAll.load(fetchDistribution);
}

$effect(() => {
  void days;
  loadDistribution();
});

const distribution = $derived(spreadOfAll.value);
const distributionFailed = $derived(spreadOfAll.error !== null);

// The pane, with everyone's cost by position or one session's

interface Pane {
  positions: Position[];

  /**
   * The session picked, or null for everyone and for a session with nothing
   * in the window.
   */
  picked: Session | null;
  models: SeriesPoint[];
}

const pane = new Latest<Pane>();
let chartWidth = $state(900);
let hoveredBar = $state<number | null>(null);

async function fetchPane(): Promise<Pane> {
  const range = windowOf(days);

  if (sessionId === undefined) {
    const response = await fetchSessionPositions(range);

    return { positions: response.positions, picked: null, models: [] };
  }

  const scope = { ...range, session_id: sessionId };
  const [found, response, [byModel]] = await Promise.all([
    fetchSessions({ ...scope, limit: 1 }),
    fetchSessionPositions(scope),
    fetchSeries({ ...scope, groupings: [['provider', 'model']] }),
  ]);

  return {
    positions: response.positions,
    picked: found.top[0] ?? null,
    models: (byModel ?? []).toSorted((a, b) => b.cost_total - a.cost_total),
  };
}

function loadPane(): void {
  void pane.load(fetchPane);
}

function retryPane(): void {
  loadPane();
  loadDistribution();
}

$effect(() => {
  void [sessionId, days];
  hoveredBar = null;
  loadPane();
});

const paneLoading = $derived(pane.loading);
const paneFailed = $derived(pane.error !== null);
const positions = $derived(pane.value?.positions ?? []);
const picked = $derived(pane.value?.picked ?? null);
const models = $derived(pane.value?.models ?? []);

// One session's requests, newest first, from the logs. They are not limited to
// the window, because they are the session's own record.
const requests = new AppendList<SessionLog>(fetchRequests, 'Failed to load requests.');

function fetchRequests(after?: string): ReturnType<typeof listLogs> {
  return listLogs({ tags: `session_id:${sessionId}`, limit: REQUEST_PAGE, after_id: after });
}

$effect(() => {
  // Emptied first, so that one session's requests are never shown under
  // another's name.
  requests.rows = [];
  requests.meta = null;

  if (sessionId !== undefined) {
    void requests.load();
  }
});

// Derived figures

const bars = $derived(binPositions(positions, MAX_BARS));

// The last position also takes every request past it, when there are any.
const tail = $derived(positions.at(-1));
const capped = $derived(tail !== undefined && tail.requests > tail.sessions);

/**
 * A position on the axis or in the tooltip. A capped last one reads '1,000+'.
 */
function positionLabel(position: number): string {
  return capped && position === tail?.position ? `${fmt(position)}+` : fmt(position);
}

const twentiethGrowth = $derived(costGrowth(positions, 20));
const spread = $derived(sessionSpread(distribution));
const pickedSpend = $derived(picked?.cost_total ?? 0);

// The share of sessions that cost less, read off everyone's p1 to p99.
const costsMoreThan = $derived(spread ? percentileRank(distribution?.cost_percentiles ?? [], pickedSpend) : null);
const comparison = $derived([
  { label: 'This session', value: pickedSpend, color: ACCENT },
  { label: 'Median session', value: spread?.medianCost ?? 0, color: '#52525b' },
  { label: 'p95 session', value: spread?.p95Cost ?? 0, color: '#52525b' },
]);
const comparisonTop = $derived(Math.max(0, ...comparison.map((row) => row.value)));

const bandSessions = $derived(distribution?.sessions ?? 0);
const bandSpend = $derived((distribution?.cost_bands ?? []).reduce((sum, band) => sum + band.cost_total, 0));
const heavy = $derived(heavySessions(distribution?.cost_bands ?? []));
const singleRequest = $derived(distribution?.request_bands[0]?.sessions ?? 0);
const topModelSpend = $derived(models[0]?.cost_total ?? 0);

// What the band cards show in place of bands, while there are none to show.
const bandsNote = $derived.by(() => {
  if (distribution === null) {
    return distributionFailed ? "Couldn't load sessions." : 'Loading…';
  }

  return bandSessions === 0 ? 'No sessions in this window.' : null;
});
</script>

<div class="grid grid-cols-1 gap-[var(--analytics-gap)] lg:grid-cols-[300px_minmax(0,1fr)]">
	<!-- As on Users, side by side the list is exactly as tall as the pane and
	     scrolls within it. Stacked, it gets a fixed cap. -->
	<div class="relative min-h-[320px]">
	<nav aria-label="Sessions" class="flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-track bg-surface-1 lg:absolute lg:inset-0 lg:max-h-none">
		<form onsubmit={openSession} class="flex flex-col gap-2 border-b border-line p-2.5">
			<Input
				bind:value={lookup}
				placeholder="Find a session id…"
				aria-label="Find a session by id"
				class="h-8 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-300"
			/>
			<FilterTabs tabs={sorts} bind:value={sort} fill />
		</form>

		<div class="flex min-h-0 flex-col overflow-y-auto p-1.5">
			<!-- Styled as a button like the sort control above it, since it's how to get
			     back to everyone. flex-none, or the scrolling list squeezes it. -->
			<a
				href={sessionsHref(null)}
				data-sveltekit-reset="false"
				aria-current={sessionId === undefined ? 'page' : undefined}
				class="flex h-9 flex-none items-center justify-between gap-3 rounded-lg border px-3 {sessionId === undefined
					? 'border-line-strong bg-seg text-zinc-50 shadow-[0_1px_2px_rgba(0,0,0,.3)]'
					: 'border-line-strong bg-surface-3 text-zinc-300 hover:bg-surface-4 hover:text-zinc-100'}"
			>
				<span class="flex items-center gap-2 text-[12.5px] font-medium"><MessagesSquareIcon class="size-3.5" />All sessions</span>
				<span class="text-[12px] text-zinc-500 tabular-nums">{sessionCount === null ? '—' : fmt(sessionCount)}</span>
			</a>

			{#if unlisted && sessionId}
				<a
					href={sessionsHref(sessionId)}
					data-sveltekit-reset="false"
					aria-current="page"
					class="mt-1 flex items-center justify-between gap-3 rounded-md bg-surface-6 px-2.5 py-2"
				>
					<span class="truncate font-mono text-[12px] text-zinc-100" title={sessionId}>{sessionId}</span>
					<span class="text-[11px] text-zinc-500">searched</span>
				</a>
			{/if}

			<div class="mx-2.5 my-1.5 border-t border-line"></div>

			{#if listLoading}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading sessions…</div>
			{:else if listFailed}
				<div class="flex flex-col items-center gap-2 py-6 text-[12.5px] text-zinc-500" role="status">
					Couldn't load sessions.
					<ToolbarButton onclick={loadList}>Retry</ToolbarButton>
				</div>
			{:else}
				{#each sessions as session (session.session_id)}
					{@const on = session.session_id === sessionId}
					<a
						href={sessionsHref(session.session_id)}
						data-sveltekit-reset="false"
						aria-current={on ? 'page' : undefined}
						class="flex flex-col gap-1 rounded-md px-2.5 py-1.5 {on ? 'bg-surface-6' : 'hover:bg-surface-4'}"
					>
						<span class="flex items-baseline justify-between gap-3">
							<span class="truncate font-mono text-[12px] {on ? 'text-zinc-100' : 'text-zinc-300'}" title={session.session_id}>{session.session_id}</span>
							<span class="flex-none text-[12px] text-zinc-300 tabular-nums">
								{sort === 'spend' ? fmtSpend(session.cost_total) : sort === 'requests' ? `${fmt(session.requests)} req` : fmtElapsed(session.seconds)}
							</span>
						</span>
						<span class="h-[2px] w-full rounded-full bg-surface-4">
							<span class="block h-full rounded-full bg-emerald-500/70" style:width={`${topMeasure > 0 ? (sessionMeasure(session, sort) / topMeasure) * 100 : 0}%`}></span>
						</span>
					</a>
				{:else}
					<div class="px-2.5 py-6 text-[12.5px] text-zinc-600">
						No sessions in this window. Send <code class="text-zinc-400">ai-log-tags: session_id:…</code> to group requests.
					</div>
				{/each}

				{#if sessionCount !== null && sessions.length < sessionCount}
					<div class="px-2.5 py-2">
						<ToolbarButton onclick={loadMore} disabled={loadingMore}>
							{loadingMore ? 'Loading…' : `Show more (${fmt(sessionCount - sessions.length)} left)`}
						</ToolbarButton>
					</div>
				{/if}
			{/if}
		</div>
	</nav>
	</div>

	<div class="flex min-w-0 flex-col transition-opacity" style:opacity={paneLoading ? 0.6 : 1} aria-busy={paneLoading}>
		{#if sessionId !== undefined}
			<StatGrid compact columns={5}>
				<StatCard compact label="Spend" value={picked ? fmtSpend(picked.cost_total) : '—'} />
				<StatCard compact label="Requests" value={picked ? fmt(picked.requests) : '—'} />
				<StatCard compact label="Length" value={picked ? fmtElapsed(picked.seconds) : '—'} />
				<StatCard compact label="Tokens used" value={picked ? fmt(picked.tokens) : '—'} />
				<StatCard compact label="Users" value={picked ? participants(picked) : '—'} />
			</StatGrid>

			{#if paneFailed}
				{@render failure()}
			{:else if !paneLoading && !picked}
				<p class="rounded-xl border border-track bg-surface-1 px-4 py-6 text-[12.5px] text-zinc-500">
					No requests from session <code class="text-zinc-300">{sessionId}</code> in the selected window.
				</p>
			{/if}

			<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
				<ChartCard title="Cost by request" hint="What each request in this session cost, and how much history it sent.">
					{#snippet actions()}{@render positionLegend()}{/snippet}
					{@render positionChart()}
					{#if positions.length > 1 && !capped}
						<p class="pt-1 pb-1 text-[12px] text-zinc-500">
							The last request sent <span class="text-zinc-200 tabular-nums">{fmt(tail?.input_tokens ?? 0)}</span> tokens of history, against
							<span class="text-zinc-200 tabular-nums">{fmt(positions[0]?.input_tokens ?? 0)}</span> on the first.
						</p>
					{/if}
				</ChartCard>

				<ChartCard title="Requests" hint="Newest first, from the logs.">
					<!-- As tall as the chart beside it, and scrolls for the rest. Log ids are
					     UUIDv7, so a session's share their leading time digits and the tail
					     tells them apart. -->
					<div class="flex h-[218px] flex-col gap-0.5 overflow-y-auto">
						<div class="sticky top-0 grid grid-cols-[64px_minmax(0,1fr)_56px_48px_60px_72px] gap-3 bg-surface-1 pb-1 text-[11px] text-zinc-500">
							<span>At</span><span>Model</span><span class="text-right">In</span><span class="text-right">Out</span><span class="text-right">Cost</span><span>Log</span>
						</div>
						{#each requests.rows as log (log.id)}
							<div class="grid grid-cols-[64px_minmax(0,1fr)_56px_48px_60px_72px] items-center gap-3 rounded-[4px] py-0.5 hover:bg-surface-6">
								<span class="text-[12.5px] whitespace-nowrap text-zinc-500 tabular-nums" title={new Date(log.created_at).toLocaleString()}>{fmtClock(log.created_at)}</span>
								<span class="flex min-w-0 items-center gap-[7px]" title="{log.provider}/{log.model}">
									<span class="size-[7px] flex-none rounded-full" style:background={providerTone(log.provider).color}></span>
									<code class="truncate font-mono text-[12px] text-zinc-200"><span class="text-zinc-500">{log.provider}/</span>{log.model}</code>
								</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(log.input_tokens ?? 0)}</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(log.output_tokens ?? 0)}</span>
								<span class="text-right text-[12.5px] text-zinc-200 tabular-nums">{log.input_cost == null || log.output_cost == null ? '—' : fmtCost(log.input_cost + log.output_cost)}</span>
								<span class="truncate font-mono text-[11.5px] text-zinc-400" title={log.id}>{log.id.slice(-8)}</span>
							</div>
						{:else}
							<p class="py-4 text-[12.5px] text-zinc-500">
								{requests.loading ? 'Loading requests…' : requests.error ? "Couldn't load this session's requests." : 'No logged requests for this session.'}
							</p>
						{/each}
						{#if requests.hasMore}
							<div class="py-1">
								<ToolbarButton onclick={() => requests.loadMore()} disabled={requests.loadingMore}>{requests.loadingMore ? 'Loading…' : 'Show older'}</ToolbarButton>
							</div>
						{/if}
					</div>
				</ChartCard>

				<ChartCard title="Compared with sessions" hint="This session's spend against every session's in the window.">
					<div class="flex min-h-[170px] flex-col gap-3">
						{#if costsMoreThan === null || !picked}
							<div class="py-8 text-center text-[12.5px] text-zinc-600">
								{distributionFailed ? "Couldn't load the other sessions." : distribution ? 'Nothing to compare with.' : 'Loading…'}
							</div>
						{:else}
							<div>
								<div class="text-[15px] text-zinc-200">
									Costs more than <span class="font-semibold text-zinc-50 tabular-nums">{costsMoreThan}%</span> of sessions
								</div>
								<div class="relative mt-2 h-[6px] w-full rounded-full bg-surface-4">
									<div class="absolute top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1" style:left="{costsMoreThan}%" style:background={ACCENT}></div>
								</div>
							</div>
							<div class="flex flex-col gap-1">
								{#each comparison as row (row.label)}
									<div class="grid grid-cols-[104px_minmax(0,1fr)_64px] items-center gap-3">
										<span class="text-[12.5px] text-zinc-400">{row.label}</span>
										<div class="h-[18px] w-full">
											<div class="h-full rounded-r-[4px]" style:width={`${comparisonTop > 0 ? (row.value / comparisonTop) * 100 : 0}%`} style:background={row.color}></div>
										</div>
										<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.value)}</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</ChartCard>

				<ChartCard title="Models" hint="What this session's requests ran on.">
					<div class="flex min-h-[170px] flex-col gap-1">
						<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_56px_64px] gap-3 pb-1 text-[11px] text-zinc-500">
							<span>Model</span><span></span><span class="text-right">Requests</span><span class="text-right">Spend</span>
						</div>
						{#each models as row (`${row.provider}/${row.model}`)}
							<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_56px_64px] items-center gap-3">
								<span class="flex min-w-0 items-center gap-[9px]" title="{row.provider}/{row.model}">
									<span class="size-[7px] shrink-0 rounded-full" style:background={providerTone(row.provider ?? '').color}></span>
									<span class="truncate text-[12.5px] text-zinc-300"><span class="text-zinc-500">{row.provider}/</span>{row.model}</span>
								</span>
								{@render bar(row.cost_total, topModelSpend)}
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.requests)}</span>
								<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.cost_total)}</span>
							</div>
						{:else}
							<div class="py-8 text-center text-[12.5px] text-zinc-600">{paneLoading ? 'Loading models…' : 'No requests in this window.'}</div>
						{/each}
					</div>
				</ChartCard>
			</div>
		{:else}
			<StatGrid compact columns={5}>
				<StatCard compact label="Sessions" value={distribution ? fmt(distribution.sessions) : '—'} />
				<StatCard compact label="Median session" value={spread ? fmtSpend(spread.medianCost) : '—'} />
				<StatCard compact label="p95 session" value={spread ? fmtSpend(spread.p95Cost) : '—'} />
				<StatCard compact label="Median requests" value={spread ? fmt(spread.medianRequests) : '—'} />
				<StatCard compact label="Median length" value={spread ? fmtElapsed(spread.medianSeconds) : '—'} />
			</StatGrid>

			{#if paneFailed || distributionFailed}
				{@render failure()}
			{/if}

			<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
				<div class="xl:col-span-2">
					<ChartCard title="Cost by request" hint="What the nth request of a session costs, on average. History is resent each time, so later requests cost more.">
						{#snippet actions()}{@render positionLegend()}{/snippet}
						{@render positionChart()}
						{#if twentiethGrowth !== null}
							<p class="pt-1 pb-1 text-[12px] text-zinc-500">
								The 20th request of a session costs <span class="text-zinc-200 tabular-nums">{twentiethGrowth.toFixed(1)}×</span> the first, on average.
							</p>
						{/if}
					</ChartCard>
				</div>

				<ChartCard title="Cost per session" hint="How many sessions cost how much, and their share of spend.">
					<div class="flex min-h-[190px] flex-col gap-1">
						{#if bandsNote || !distribution}
							<div class="py-8 text-center text-[12.5px] text-zinc-600">{bandsNote}</div>
						{:else}
							<div class="grid grid-cols-[72px_minmax(0,1fr)_104px_56px] gap-3 pb-1 text-[11px] text-zinc-500">
								<span>Spend</span><span></span><span class="text-right">Sessions</span><span class="text-right">Of spend</span>
							</div>
							{#each distribution.cost_bands as band (band.min)}
								<div class="grid grid-cols-[72px_minmax(0,1fr)_104px_56px] items-center gap-3">
									<span class="text-[12.5px] text-zinc-300 tabular-nums">{costBand(band.min, band.max)}</span>
									{@render bar(band.sessions, bandSessions)}
									<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {fmtPercent(band.sessions / bandSessions)}</span>
									<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{bandSpend > 0 ? fmtPercent(band.cost_total / bandSpend) : '—'}</span>
								</div>
							{/each}
							{#if heavy.sessions > 0 && bandSpend > 0}
								<p class="pt-1 text-[11.5px] text-zinc-500">
									The {fmtPercent(heavy.sessions / bandSessions)} of sessions over $1 are {fmtPercent(heavy.spend / bandSpend)} of spend.
								</p>
							{/if}
						{/if}
					</div>
				</ChartCard>

				<ChartCard title="Requests per session" hint="How many requests a session takes.">
					<div class="flex min-h-[190px] flex-col gap-1">
						{#if bandsNote || !distribution}
							<div class="py-8 text-center text-[12.5px] text-zinc-600">{bandsNote}</div>
						{:else}
							{#each distribution.request_bands as band (band.min)}
								<div class="grid grid-cols-[72px_minmax(0,1fr)_104px] items-center gap-3">
									<span class="text-[12.5px] text-zinc-300 tabular-nums">{requestBand(band.min, band.max)}</span>
									{@render bar(band.sessions, bandSessions)}
									<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {fmtPercent(band.sessions / bandSessions)}</span>
								</div>
							{/each}
							<p class="pt-1 text-[11.5px] text-zinc-500">
								{fmtPercent(singleRequest / bandSessions)} of sessions are a single request.
							</p>
						{/if}
					</div>
				</ChartCard>
			</div>
		{/if}
	</div>
</div>

{#snippet failure()}
	<div class="mb-[var(--analytics-gap)] flex items-center justify-between gap-2 text-[12.5px] text-zinc-500" role="status">
		<span>Couldn't load {sessionId ?? 'sessions'}.</span>
		<ToolbarButton onclick={retryPane}>Retry</ToolbarButton>
	</div>
{/snippet}

{#snippet positionLegend()}
	<div class="flex items-center gap-3 text-[11.5px] text-zinc-400">
		<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={ACCENT}></span>Cost per request</span>
		<span class="flex items-center gap-1.5"><span class="h-[2px] w-3 rounded-full" style:background={INPUT_INK}></span>Context in</span>
	</div>
{/snippet}

<!-- Bars for cost per request, a line for the history sent, on two axes. -->
{#snippet positionChart()}
	{#if bars.length === 0}
		<div class="flex items-center justify-center text-[12.5px] text-zinc-600" style:height="{HEIGHT}px">
			{paneLoading ? 'Loading…' : 'No session requests in this window.'}
		</div>
	{:else}
		{@const costTop = Math.max(...bars.map((row) => row.cost)) * 1.1 || 1}
		{@const inputTop = Math.max(...bars.map((row) => row.input)) * 1.1 || 1}
		{@const slot = (chartWidth - PAD.left - PAD.right) / Math.max(1, bars.length)}
		<!-- About eight labels whatever the length, and never one crowding the last. -->
		{@const every = Math.max(1, Math.ceil(bars.length / 8))}
		{@const hovered = hoveredBar === null ? null : bars[hoveredBar]}
		<div class="relative" bind:clientWidth={chartWidth}>
			<svg width={chartWidth} height={HEIGHT} role="img" aria-label="Cost per request by its position in the session, with context size">
				{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
					{@const y = PAD.top + plotHeight * (1 - tick)}
					<line x1={PAD.left} y1={y} x2={chartWidth - PAD.right} y2={y} stroke={GRID} />
					<text x={PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">{fmtCost(costTop * tick)}</text>
					<text x={chartWidth - PAD.right + 8} y={y + 3.5} font-size="10" fill={AXIS_INK} class="tabular-nums">{fmt(Math.round(inputTop * tick))}</text>
				{/each}
				{#each bars as row, index (row.first)}
					{@const height = (row.cost / costTop) * plotHeight}
					<rect
						x={PAD.left + slot * index + slot * 0.18}
						y={PAD.top + plotHeight - height}
						width={slot * 0.64}
						{height}
						rx="2"
						fill={ACCENT}
						opacity={hoveredBar === null || hoveredBar === index ? 0.85 : 0.35}
					/>
					{#if (index % every === 0 && bars.length - 1 - index >= every / 2) || index === bars.length - 1}
						<text x={PAD.left + slot * (index + 0.5)} y={HEIGHT - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>{positionLabel(row.first)}</text>
					{/if}
				{/each}
				<polyline
					points={bars.map((row, index) => `${PAD.left + slot * (index + 0.5)},${PAD.top + plotHeight * (1 - row.input / inputTop)}`).join(' ')}
					fill="none"
					stroke={INPUT_INK}
					stroke-width="1.75"
				/>
			</svg>
			{#each bars as row, index (row.first)}
				<button
					type="button"
					class="absolute"
					style:left="{PAD.left + slot * index}px"
					style:top="{PAD.top}px"
					style:width="{slot}px"
					style:height="{plotHeight}px"
					aria-label="{row.last > row.first ? `Requests ${row.first} to ${positionLabel(row.last)}` : `Request ${positionLabel(row.first)}`}: {fmtCost(row.cost)}, {fmt(Math.round(row.input))} tokens in"
					onmouseenter={() => (hoveredBar = index)}
					onmouseleave={() => (hoveredBar = null)}
				></button>
			{/each}
			{#if hovered && hoveredBar !== null}
				<div
					class="pointer-events-none absolute top-1 z-10 w-48 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-3 py-2 text-[11.5px] shadow-lg"
					style:left="{Math.min(Math.max(PAD.left + slot * (hoveredBar + 0.5), 100), chartWidth - 100)}px"
				>
					<div class="mb-1 text-zinc-500">
						{hovered.last > hovered.first ? `Requests ${fmt(hovered.first)} – ${positionLabel(hovered.last)}` : `Request ${positionLabel(hovered.first)}`}
					</div>
					<div class="flex justify-between gap-3 text-emerald-400">
						<span>{sessionId === undefined || hovered.last > hovered.first ? 'Per request' : 'Cost'}</span><span class="tabular-nums">{fmtCost(hovered.cost)}</span>
					</div>
					<div class="flex justify-between gap-3 text-blue-400"><span>Context in</span><span class="tabular-nums">{fmt(Math.round(hovered.input))}</span></div>
					{#if sessionId === undefined}
						<div class="flex justify-between gap-3 text-zinc-400"><span>Sessions this long</span><span class="tabular-nums">{fmt(hovered.sessions)}</span></div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- A row's bar, against the biggest in its list, as on the other tabs. -->
{#snippet bar(value: number, top: number)}
	<div class="h-[18px] w-full">
		<div
			class="h-full rounded-r-[4px]"
			style:width={`${top > 0 ? (value / top) * 100 : 0}%`}
			style:background={ACCENT}
			style:opacity={0.35 + 0.65 * (top > 0 ? value / top : 0)}
		></div>
	</div>
{/snippet}
