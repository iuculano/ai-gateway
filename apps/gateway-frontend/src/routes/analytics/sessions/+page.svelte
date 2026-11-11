<script lang="ts">
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import {
  fetchSeries,
  fetchSessionDistribution,
  fetchSessionPositions,
  fetchSessions,
  type SeriesPoint,
  type SessionDistributionResponse,
  type SessionPositionsResponse,
  type SessionsResponse,
} from '$lib/api/analytics';
import { listLogs } from '$lib/api/logs';
import { alignedNow, getAnalyticsFilters } from '$lib/components/analytics/analytics-filters.svelte';
import ChartCard from '$lib/components/app/chart-card.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { Input } from '$lib/components/ui/input';
import { fmt, fmtCost, fmtSpend, providerTone } from '$lib/data/format';

/**
 * Sessions from the session_id tag, laid out like the Users tab. The list is on
 * the left and everyone's figures, or one session's, on the right.
 *
 * Figures cover the selected window, so a session that started before it
 * shows only its part inside it. The picked session lives in ?session=.
 */

const ACCENT = '#10b981';
const INPUT_INK = '#60a5fa';
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
// Sessions per page of the list.
const PAGE = 50;
// Requests per page of one session's list.
const REQUEST_PAGE = 50;
// Past this many positions the chart groups them, so bars stay wide enough to read and hover.
const MAX_BARS = 60;

type Session = SessionsResponse['top'][number];
type Position = SessionPositionsResponse['positions'][number];
type SessionLog = Awaited<ReturnType<typeof listLogs>>['data'][number];

/** One bar of the chart, for a position or a run of them, averaged per request. */
interface PositionBar {
  first: number;
  last: number;
  /** Average cost of a request at these positions. */
  cost: number;
  /** Average input tokens, i.e. the history sent. */
  input: number;
  /** Sessions that got as far as the first of these positions. */
  sessions: number;
}

const filters = getAnalyticsFilters();
const days = $derived(filters.range.days);
const sessionId = $derived(page.url.searchParams.get('session') ?? undefined);

/** The window every request asks about, rounded so repeats hit the server's cache. */
function rangeOf() {
  const end = alignedNow();
  return {
    start_date: new Date(end - days * 86_400_000).toISOString(),
    end_date: new Date(end).toISOString(),
  };
}

// The list ---------------------------------------------------------------------

let sort = $state<'spend' | 'requests' | 'length'>('spend');
const sorts = [
  { id: 'spend', label: 'Spend' },
  { id: 'requests', label: 'Requests' },
  { id: 'length', label: 'Length' },
] satisfies { id: typeof sort; label: string }[];

let sessions = $state<Session[]>([]);
let sessionCount = $state<number | null>(null);
let listLoading = $state(true);
let listFailed = $state(false);
let loadingMore = $state(false);
let listRequest = 0;
// The window the list was loaded for. Later pages reuse it, so a page fetched
// after the window moves on can't skip or repeat sessions.
let listRange = { start_date: '', end_date: '' };

async function loadList() {
  const current = ++listRequest;
  listLoading = true;
  listFailed = false;
  try {
    const range = rangeOf();
    const response = await fetchSessions({ ...range, limit: PAGE, sort });
    if (current !== listRequest) return;
    listRange = range;
    sessions = response.top;
    sessionCount = response.count;
  } catch {
    if (current === listRequest) listFailed = true;
  } finally {
    if (current === listRequest) listLoading = false;
  }
}

/** The next page of sessions, added to the end of the list. */
async function loadMore() {
  const current = listRequest;
  loadingMore = true;
  try {
    const response = await fetchSessions({ ...listRange, limit: PAGE, offset: sessions.length, sort });
    if (current === listRequest) sessions = [...sessions, ...response.top];
  } catch {
    // The list keeps what it has and the button stays, so it can be tried again.
  } finally {
    loadingMore = false;
  }
}

$effect(() => {
  void [days, sort];
  void loadList();
});

/** A session's figure for the chosen order. */
function measure(session: Session) {
  return sort === 'spend' ? session.cost_total : sort === 'requests' ? session.requests : session.seconds;
}

const topMeasure = $derived(sessions[0] ? measure(sessions[0]) : 0);
const unlisted = $derived(sessionId !== undefined && !sessions.some((session) => session.session_id === sessionId));

/** This tab's URL with a session picked, or everyone. */
function sessionsHref(id: string | null) {
  return id ? `/analytics/sessions?session=${encodeURIComponent(id)}` : '/analytics/sessions';
}

let lookup = $state('');

function openSession(event: SubmitEvent) {
  event.preventDefault();
  const id = lookup.trim();
  if (id) void goto(sessionsHref(id), { noScroll: true });
}

// Everyone's spread, also what one session is compared against ---------------------

let distribution = $state<SessionDistributionResponse | null>(null);
let distributionFailed = $state(false);
let distributionRequest = 0;

async function loadDistribution() {
  const current = ++distributionRequest;
  distributionFailed = false;
  try {
    const response = await fetchSessionDistribution(rangeOf());
    if (current === distributionRequest) distribution = response;
  } catch {
    if (current === distributionRequest) distributionFailed = true;
  }
}

$effect(() => {
  void days;
  void loadDistribution();
});

// The pane, with everyone's cost by position or one session ------------------------

let positions = $state<Position[]>([]);
let picked = $state<Session | null>(null);
let models = $state<SeriesPoint[]>([]);
let paneLoading = $state(true);
let paneFailed = $state(false);
let paneRequest = 0;

async function loadPane() {
  const current = ++paneRequest;
  paneLoading = true;
  paneFailed = false;
  const range = rangeOf();
  try {
    if (sessionId === undefined) {
      const response = await fetchSessionPositions(range);
      if (current !== paneRequest) return;
      positions = response.positions;
      picked = null;
      models = [];
    } else {
      const scope = { ...range, session_id: sessionId };
      const [found, response, [byModel]] = await Promise.all([
        fetchSessions({ ...scope, limit: 1 }),
        fetchSessionPositions(scope),
        fetchSeries({ ...scope, groupings: [['provider', 'model']] }),
      ]);
      if (current !== paneRequest) return;
      picked = found.top[0] ?? null;
      positions = response.positions;
      models = (byModel ?? []).toSorted((a, b) => b.cost_total - a.cost_total);
    }
  } catch {
    if (current === paneRequest) paneFailed = true;
  } finally {
    if (current === paneRequest) paneLoading = false;
  }
}

$effect(() => {
  void [sessionId, days];
  hoveredBar = null;
  void loadPane();
});

// One session's requests, newest first, from the logs. They aren't limited to
// the window, because they're the session's own record.
let requestLogs = $state<SessionLog[]>([]);
let olderId = $state<string | null>(null);
let requestsLoading = $state(false);
let requestsFailed = $state(false);
let requestsRequest = 0;

async function loadRequests(more = false) {
  if (sessionId === undefined) return;
  const current = more ? requestsRequest : ++requestsRequest;
  requestsLoading = true;
  requestsFailed = false;
  try {
    const response = await listLogs({
      tags: `session_id:${sessionId}`,
      limit: REQUEST_PAGE,
      ...(more && olderId ? { after_id: olderId } : {}),
    });
    if (current !== requestsRequest) return;
    requestLogs = more ? [...requestLogs, ...response.data] : response.data;
    olderId = response.meta.more_data ? response.meta.oldest_id : null;
  } catch {
    if (current === requestsRequest) requestsFailed = true;
  } finally {
    if (current === requestsRequest) requestsLoading = false;
  }
}

$effect(() => {
  void sessionId;
  requestLogs = [];
  olderId = null;
  void loadRequests();
});

// Derived figures ----------------------------------------------------------------

/**
 * Groups positions into at most MAX_BARS bars. Sums are added up before
 * dividing, so a bar is the true average of the requests it covers.
 *
 * @param rows
 * One row per position, in order.
 */
function binPositions(rows: Position[]): PositionBar[] {
  const size = Math.max(1, Math.ceil(rows.length / MAX_BARS));
  const bars: PositionBar[] = [];
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    let cost = 0;
    let input = 0;
    let requests = 0;
    for (const row of chunk) {
      cost += row.cost_total;
      input += row.input_tokens;
      requests += row.requests;
    }
    const first = chunk[0] as Position;
    bars.push({
      first: first.position,
      last: (chunk.at(-1) as Position).position,
      cost: requests > 0 ? cost / requests : 0,
      input: requests > 0 ? input / requests : 0,
      sessions: first.sessions,
    });
  }
  return bars;
}

const bars = $derived(binPositions(positions));
// The last position also takes every request past it, when there are any.
const tail = $derived(positions.at(-1));
const capped = $derived(tail !== undefined && tail.requests > tail.sessions);

/** A position on the axis or in the tooltip. A capped last one reads '1,000+'. */
function positionLabel(position: number) {
  return capped && position === tail?.position ? `${fmt(position)}+` : fmt(position);
}

// How much more a later request costs than the first, across everyone.
const firstCost = $derived(positions[0] ? positions[0].cost_total / positions[0].requests : 0);
const twentiethCost = $derived.by(() => {
  const row = positions.find((position) => position.position === 20);
  return row ? row.cost_total / row.requests : null;
});

// Everyone's typical and heavy session, once there are sessions to place.
const spread = $derived(
  distribution?.sessions
    ? {
        medianCost: distribution.cost_percentiles[49] ?? 0,
        p95Cost: distribution.cost_percentiles[94] ?? 0,
        medianRequests: Math.round(distribution.request_percentiles[49] ?? 0),
        medianSeconds: distribution.seconds_percentiles[49] ?? 0,
      }
    : null,
);
const pickedSpend = $derived(picked?.cost_total ?? 0);
// The share of sessions that cost less, read off everyone's p1 to p99.
const costsMoreThan = $derived(
  spread ? (distribution?.cost_percentiles ?? []).filter((value) => value < pickedSpend).length : null,
);
const comparison = $derived([
  { label: 'This session', value: pickedSpend, color: ACCENT },
  { label: 'Median session', value: spread?.medianCost ?? 0, color: '#52525b' },
  { label: 'p95 session', value: spread?.p95Cost ?? 0, color: '#52525b' },
]);
const comparisonTop = $derived(Math.max(0, ...comparison.map((row) => row.value)));

const bandSessions = $derived(distribution?.sessions ?? 0);
// What the band cards show instead of bands, while there are none to show.
const bandsNote = $derived(
  distribution === null
    ? distributionFailed
      ? "Couldn't load sessions."
      : 'Loading…'
    : bandSessions === 0
      ? 'No sessions in this window.'
      : null,
);
const bandSpend = $derived((distribution?.cost_bands ?? []).reduce((sum, band) => sum + band.cost_total, 0));
// How much of the spend the sessions over $1 are.
const heavy = $derived.by(() => {
  let sessionsOver = 0;
  let spendOver = 0;
  for (const band of distribution?.cost_bands ?? []) {
    if (band.min < 1) continue;
    sessionsOver += band.sessions;
    spendOver += band.cost_total;
  }
  return { sessions: sessionsOver, spend: spendOver };
});
const singleRequest = $derived(distribution?.request_bands[0]?.sessions ?? 0);
const topModelSpend = $derived(models[0]?.cost_total ?? 0);

/** Who took part, as the one user or how many shared it. */
function who(session: Session) {
  return session.user_id || (session.users > 1 ? `${fmt(session.users)} users` : '—');
}

/** A length in seconds at the coarsest units that still read, such as '4m 12s'. */
function duration(seconds: number) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A spend band's edge, in cents under a dollar and dollars above. */
function bandMoney(dollars: number) {
  return dollars < 1 ? `${Math.round(dollars * 100)}¢` : `$${dollars}`;
}

/** A spend band's range, such as '1¢ – 10¢' or '$10+'. */
function costBand(min: number, max: number | null) {
  if (max === null) return `${bandMoney(min)}+`;
  return min === 0 ? `< ${bandMoney(max)}` : `${bandMoney(min)} – ${bandMoney(max)}`;
}

/** A request-count band's range, such as '2 – 5' or '21+'. */
function requestBand(min: number, max: number | null) {
  if (max === null) return `${min}+`;
  return min === max ? `${min}` : `${min} – ${max}`;
}

function percent(share: number) {
  return `${Math.round(share * 100)}%`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// The chart's drawing area.
const HEIGHT = 190;
const PAD = { top: 14, right: 46, bottom: 24, left: 50 };
const plotHeight = HEIGHT - PAD.top - PAD.bottom;
let chartWidth = $state(900);
let hoveredBar = $state<number | null>(null);
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
				data-sveltekit-noscroll
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
					data-sveltekit-noscroll
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
						data-sveltekit-noscroll
						aria-current={on ? 'page' : undefined}
						class="flex flex-col gap-1 rounded-md px-2.5 py-1.5 {on ? 'bg-surface-6' : 'hover:bg-surface-4'}"
					>
						<span class="flex items-baseline justify-between gap-3">
							<span class="truncate font-mono text-[12px] {on ? 'text-zinc-100' : 'text-zinc-300'}" title={session.session_id}>{session.session_id}</span>
							<span class="flex-none text-[12px] text-zinc-300 tabular-nums">
								{sort === 'spend' ? fmtSpend(session.cost_total) : sort === 'requests' ? `${fmt(session.requests)} req` : duration(session.seconds)}
							</span>
						</span>
						<span class="h-[2px] w-full rounded-full bg-surface-4">
							<span class="block h-full rounded-full bg-emerald-500/70" style:width={`${topMeasure > 0 ? (measure(session) / topMeasure) * 100 : 0}%`}></span>
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
				<StatCard compact label="Length" value={picked ? duration(picked.seconds) : '—'} />
				<StatCard compact label="Tokens used" value={picked ? fmt(picked.tokens) : '—'} />
				<StatCard compact label="Users" value={picked ? who(picked) : '—'} />
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
						{#each requestLogs as log (log.id)}
							<div class="grid grid-cols-[64px_minmax(0,1fr)_56px_48px_60px_72px] items-center gap-3 rounded-[4px] py-0.5 hover:bg-surface-6">
								<span class="text-[12.5px] whitespace-nowrap text-zinc-500 tabular-nums" title={new Date(log.created_at).toLocaleString()}>{clock(log.created_at)}</span>
								<span class="flex min-w-0 items-center gap-[7px]" title="{log.provider}/{log.model}">
									<span class="size-[7px] flex-none rounded-full" style:background={providerTone(log.provider).color}></span>
									<code class="truncate font-mono text-[12px] text-zinc-200"><span class="text-zinc-500">{log.provider}/</span>{log.model}</code>
								</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(log.input_tokens ?? 0)}</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(log.output_tokens ?? 0)}</span>
								<span class="text-right text-[12.5px] text-zinc-200 tabular-nums">{fmtCost(log.input_cost + log.output_cost)}</span>
								<span class="truncate font-mono text-[11.5px] text-zinc-400" title={log.id}>{log.id.slice(-8)}</span>
							</div>
						{:else}
							<p class="py-4 text-[12.5px] text-zinc-500">
								{requestsLoading ? 'Loading requests…' : requestsFailed ? "Couldn't load this session's requests." : 'No logged requests for this session.'}
							</p>
						{/each}
						{#if olderId}
							<div class="py-1">
								<ToolbarButton onclick={() => loadRequests(true)} disabled={requestsLoading}>{requestsLoading ? 'Loading…' : 'Show older'}</ToolbarButton>
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
				<StatCard compact label="Median length" value={spread ? duration(spread.medianSeconds) : '—'} />
			</StatGrid>

			{#if paneFailed || distributionFailed}
				{@render failure()}
			{/if}

			<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
				<div class="xl:col-span-2">
					<ChartCard title="Cost by request" hint="What the nth request of a session costs, on average. History is resent each time, so later requests cost more.">
						{#snippet actions()}{@render positionLegend()}{/snippet}
						{@render positionChart()}
						{#if twentiethCost !== null && firstCost > 0}
							<p class="pt-1 pb-1 text-[12px] text-zinc-500">
								The 20th request of a session costs <span class="text-zinc-200 tabular-nums">{(twentiethCost / firstCost).toFixed(1)}×</span> the first, on average.
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
									<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {percent(band.sessions / bandSessions)}</span>
									<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{bandSpend > 0 ? percent(band.cost_total / bandSpend) : '—'}</span>
								</div>
							{/each}
							{#if heavy.sessions > 0 && bandSpend > 0}
								<p class="pt-1 text-[11.5px] text-zinc-500">
									The {percent(heavy.sessions / bandSessions)} of sessions over $1 are {percent(heavy.spend / bandSpend)} of spend.
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
									<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {percent(band.sessions / bandSessions)}</span>
								</div>
							{/each}
							<p class="pt-1 text-[11.5px] text-zinc-500">
								{percent(singleRequest / bandSessions)} of sessions are a single request.
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
		<ToolbarButton
			onclick={() => {
				void loadPane();
				void loadDistribution();
			}}>Retry</ToolbarButton
		>
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
