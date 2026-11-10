<script lang="ts">
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import ChartCard from '$lib/components/app/chart-card.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { Input } from '$lib/components/ui/input';
import { fmt, fmtCost, fmtSpend, providerTone } from '$lib/data/format';

/**
 * MOCKUP. The Sessions tab with made-up figures, to settle the layout before
 * any query exists. Nothing here is fetched.
 *
 * Laid out like the Users tab: the sessions on the left, biggest first, with
 * "All sessions" at the top; everyone's figures or one session's on the right.
 * The pick lives in the URL (?session=).
 */

const ACCENT = '#10b981';
const P95_INK = '#60a5fa';
const INPUT_INK = '#60a5fa';
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COMPARED = { text: '↑ 12.4%', color: '#60a5fa', title: 'Against the previous 30 days.' };

// A fixed pseudo-random sequence, so the mock looks the same on every load.
let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

interface TurnRow {
  turn: number;
  cost: number;
  context: number;
  output: number;
  model: string;
  /** Minutes after the session's first request. */
  at: number;
  /** Everyone's view only: how many sessions got this far. */
  sessions?: number;
  /** Set on a bar standing for several turns: the last of them. */
  last?: number;
  /** A session's own requests only: the log behind the turn. */
  id?: string;
}

// Past this many turns the chart groups them, so bars stay wide enough to read and hover.
const MAX_BARS = 60;

/**
 * Groups turns into at most MAX_BARS bars, each the average of its turns, so a
 * 1,000-turn session still draws as a readable chart.
 *
 * @param rows
 * One row per turn, in order.
 */
function binTurns(rows: TurnRow[]): TurnRow[] {
  if (rows.length <= MAX_BARS) return rows;
  const size = Math.ceil(rows.length / MAX_BARS);
  const bars: TurnRow[] = [];
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    let cost = 0;
    let context = 0;
    for (const row of chunk) {
      cost += row.cost;
      context += row.context;
    }
    const first = chunk[0] as TurnRow;
    const last = chunk.at(-1) as TurnRow;
    bars.push({
      turn: first.turn,
      last: last.turn,
      cost: cost / chunk.length,
      context: Math.round(context / chunk.length),
      output: 0,
      model: '',
      at: first.at,
    });
  }
  return bars;
}

// Everyone's cost by turn: each turn resends the history, so context and cost climb.
const turns: TurnRow[] = [];
for (let turn = 1; turn <= 30; turn++) {
  const context = 900 + turn * 1450 + random() * 600;
  turns.push({
    turn,
    context: Math.round(context),
    output: 0,
    model: '',
    at: 0,
    cost: (context / 1_000_000) * 2.5 + 0.0012 + random() * 0.0006,
    sessions: Math.round(4812 * Math.exp(-turn / 7)),
  });
}
const firstTurn = turns[0]?.cost ?? 0;
const turnTwenty = turns[19]?.cost ?? 0;

// Cost per session, per day: the median and the heavy end.
const days: { day: string; median: number; p95: number }[] = [];
for (let index = 0; index < 30; index++) {
  const date = new Date(2026, 9, 5 + index);
  days.push({
    day: `${MONTHS[date.getMonth()]} ${date.getDate()}`,
    median: 0.034 + index * 0.0003 + random() * 0.008,
    p95: 0.48 + index * 0.006 + random() * 0.14,
  });
}

const costBands = [
  { label: '< 1¢', sessions: 1204, cost: 6.1 },
  { label: '1¢ – 10¢', sessions: 2318, cost: 98.4 },
  { label: '10¢ – $1', sessions: 1077, cost: 312.9 },
  { label: '$1 – $10', sessions: 201, cost: 524.0 },
  { label: '$10+', sessions: 12, cost: 188.3 },
];
const turnBands = [
  { label: '1', sessions: 1388 },
  { label: '2 – 5', sessions: 1702 },
  { label: '6 – 10', sessions: 981 },
  { label: '11 – 20', sessions: 529 },
  { label: '21+', sessions: 212 },
];
const bandSessions = costBands.reduce((sum, band) => sum + band.sessions, 0);
const bandCost = costBands.reduce((sum, band) => sum + band.cost, 0);
const apps = [
  { name: 'support-chat', sessions: 2140, median: 0.061, spend: 612.4 },
  { name: 'checkout-prod', sessions: 1388, median: 0.012, spend: 88.1 },
  { name: 'docs-assistant', sessions: 904, median: 0.094, spend: 341.7 },
  { name: 'internal-tools', sessions: 380, median: 0.027, spend: 87.5 },
];
const topAppSessions = Math.max(...apps.map((app) => app.sessions));

const sessions = [
  { id: 'ses_9f2c41aa0e7d13b6', who: 'u_4821', users: 1, turns: 46, minutes: 92, tokens: 1_840_000, cost: 14.21 },
  { id: 'ses_1b77e0c3d95a2f40', who: '3 users', users: 3, turns: 38, minutes: 214, tokens: 1_210_500, cost: 9.87 },
  { id: 'ses_c03a9e5517bd8e21', who: 'u_0193', users: 1, turns: 29, minutes: 41, tokens: 905_200, cost: 6.4 },
  { id: 'ses_7e5d2b18fa04c9d3', who: 'u_7720', users: 1, turns: 24, minutes: 33, tokens: 688_000, cost: 4.95 },
  { id: 'ses_4a61f8c2e3b70d55', who: 'u_4821', users: 1, turns: 22, minutes: 58, tokens: 590_400, cost: 4.12 },
  { id: 'ses_e8b3047d1c6a95f2', who: 'u_3310', users: 1, turns: 17, minutes: 12, tokens: 402_100, cost: 2.88 },
  { id: 'ses_52d0a7e9b18c3f64', who: 'u_0193', users: 1, turns: 31, minutes: 140, tokens: 377_900, cost: 2.41 },
  { id: 'ses_0c8f4e2a7d91b5e3', who: 'u_6604', users: 1, turns: 12, minutes: 9, tokens: 288_000, cost: 1.97 },
  { id: 'ses_b4e91c07a3f6d228', who: '2 users', users: 2, turns: 15, minutes: 66, tokens: 251_300, cost: 1.62 },
  { id: 'ses_6a3d58f1c0e2974b', who: 'u_1187', users: 1, turns: 9, minutes: 7, tokens: 190_400, cost: 1.18 },
  { id: 'ses_d71e0b4c96a85f32', who: 'u_7720', users: 1, turns: 8, minutes: 21, tokens: 133_800, cost: 0.84 },
  { id: 'ses_3f9a2c6e81d04b75', who: 'u_2245', users: 1, turns: 5, minutes: 3, tokens: 61_200, cost: 0.31 },
  // Long ones, to see how the tab holds up: a day-long chat, and an agent loop
  // that summarizes its history every 40 turns.
  { id: 'ses_f0b6d3a1e87c4259', who: 'u_0193', users: 1, turns: 180, minutes: 610, tokens: 6_240_000, cost: 17.8 },
  { id: 'ses_a5c2e9f04d7b13e8', who: 'u_9001', users: 1, turns: 1240, minutes: 382, tokens: 48_600_000, cost: 61.3 },
];
type Session = (typeof sessions)[number];
const TOTAL_SESSIONS = 4812;

let sort = $state<'spend' | 'turns' | 'length'>('spend');
const sorts = [
  { id: 'spend', label: 'Spend' },
  { id: 'turns', label: 'Turns' },
  { id: 'length', label: 'Length' },
] satisfies { id: typeof sort; label: string }[];
const sorted = $derived(sessions.toSorted((a, b) => measure(b) - measure(a)));
const topMeasure = $derived(sorted[0] ? measure(sorted[0]) : 0);

/** A session's figure for the chosen order. */
function measure(session: Session) {
  return sort === 'spend' ? session.cost : sort === 'turns' ? session.turns : session.minutes;
}

const sessionId = $derived(page.url.searchParams.get('session') ?? undefined);
// A session found by search may not be on the list; the mock makes one up.
const picked = $derived.by(() => {
  if (!sessionId) return null;
  const listed = sessions.find((session) => session.id === sessionId);
  if (listed) return listed;
  return { id: sessionId, who: 'u_5512', users: 1, turns: 14, minutes: 26, tokens: 214_600, cost: 1.44 };
});
const unlisted = $derived(sessionId !== undefined && !sessions.some((session) => session.id === sessionId));

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

/**
 * One session's requests, made up from its size so each session looks different
 * but the same on every load.
 *
 * @param session
 * The session to invent requests for.
 */
function requestsOf(session: Session): TurnRow[] {
  let local = session.turns * 7919 + session.minutes;
  const rows: TurnRow[] = [];
  for (let turn = 1; turn <= session.turns; turn++) {
    local = (local * 16807) % 2147483647;
    const jitter = local / 2147483647;
    // Long sessions summarize every 40 turns, so context saws back down to a
    // summary; a 40-odd turn one trims once, at 25.
    const since = session.turns > 60 ? ((turn - 1) % 40) + 1 : turn > 25 && session.turns > 40 ? turn - 22 : turn;
    const context = Math.round((session.turns > 60 ? 6000 : 1200) + since * 1900 + jitter * 900);
    const model = turn % 6 === 0 ? 'anthropic/claude-haiku-5-5' : 'openai/gpt-5.1';
    // Shaped like the UUIDv7s logs get: time first, then random.
    const hex = local.toString(16).padStart(8, '0');
    const id = `019f3a2c-${(turn * 977).toString(16).padStart(4, '0').slice(-4)}-7${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex}${hex.slice(0, 4)}`;
    rows.push({
      id,
      turn,
      context,
      output: Math.round(180 + jitter * 700),
      model,
      at: Math.round((session.minutes * (turn - 1)) / Math.max(1, session.turns - 1)),
      cost: (context * (model.startsWith('openai') ? 2.5 : 1)) / 1_000_000 + 0.002,
    });
  }
  // Scaled so the requests add up to the session's listed spend.
  let total = 0;
  for (const row of rows) total += row.cost;
  for (const row of rows) row.cost *= session.cost / total;
  return rows;
}

const requests = $derived(picked ? requestsOf(picked) : []);
const pickedModels = $derived.by(() => {
  const byModel = new Map<string, { requests: number; cost: number }>();
  for (const row of requests) {
    const entry = byModel.get(row.model) ?? { requests: 0, cost: 0 };
    entry.requests += 1;
    entry.cost += row.cost;
    byModel.set(row.model, entry);
  }
  return [...byModel].map(([model, entry]) => ({ model, ...entry })).toSorted((a, b) => b.cost - a.cost);
});
const pickedSpend = $derived(requests.reduce((sum, row) => sum + row.cost, 0));
// Placed among every session's spend, from made-up percentiles.
const costsMoreThan = $derived(pickedSpend > 10 ? 99 : pickedSpend > 1 ? 96 : pickedSpend > 0.1 ? 78 : 40);
const comparison = $derived([
  { label: 'This session', value: pickedSpend, color: ACCENT },
  { label: 'Median session', value: 0.042, color: '#52525b' },
  { label: 'p95 session', value: 0.61, color: '#52525b' },
]);
const comparisonTop = $derived(Math.max(...comparison.map((row) => row.value)));

// The charts' drawing area.
const HEIGHT = 190;
const PAD = { top: 14, right: 46, bottom: 24, left: 50 };
const plotHeight = HEIGHT - PAD.top - PAD.bottom;
let turnWidth = $state(900);
let dayWidth = $state(500);
let hoveredTurn = $state<number | null>(null);

const dayTop = Math.max(...days.map((row) => row.p95)) * 1.1;
const daySlot = $derived((dayWidth - PAD.left - PAD.right) / Math.max(1, days.length - 1));
const medianLine = $derived(
  days
    .map((row, index) => `${PAD.left + daySlot * index},${PAD.top + plotHeight * (1 - row.median / dayTop)}`)
    .join(' '),
);
const p95Line = $derived(
  days.map((row, index) => `${PAD.left + daySlot * index},${PAD.top + plotHeight * (1 - row.p95 / dayTop)}`).join(' '),
);

// Switching views clears the tooltip.
$effect(() => {
  void sessionId;
  hoveredTurn = null;
});

function minutes(total: number) {
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
}

function percent(share: number) {
  return `${Math.round(share * 100)}%`;
}
</script>

<div class="grid grid-cols-1 gap-[var(--analytics-gap)] lg:grid-cols-[300px_minmax(0,1fr)]">
	<!-- As on Users: side by side, the list is exactly as tall as the pane and
	     scrolls within it; stacked, it gets a fixed cap. -->
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
			<!-- Styled as a button, like the sort control above it: it's how to get back to everyone.
			     flex-none, or the scrolling list squeezes it below its height. -->
			<a
				href={sessionsHref(null)}
				data-sveltekit-noscroll
				aria-current={sessionId === undefined ? 'page' : undefined}
				class="flex h-9 flex-none items-center justify-between gap-3 rounded-lg border px-3 {sessionId === undefined
					? 'border-line-strong bg-seg text-zinc-50 shadow-[0_1px_2px_rgba(0,0,0,.3)]'
					: 'border-line-strong bg-surface-3 text-zinc-300 hover:bg-surface-4 hover:text-zinc-100'}"
			>
				<span class="flex items-center gap-2 text-[12.5px] font-medium"><MessagesSquareIcon class="size-3.5" />All sessions</span>
				<span class="text-[12px] text-zinc-500 tabular-nums">{fmt(TOTAL_SESSIONS)}</span>
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

			{#each sorted as session (session.id)}
				{@const on = session.id === sessionId}
				<a
					href={sessionsHref(session.id)}
					data-sveltekit-noscroll
					aria-current={on ? 'page' : undefined}
					class="flex flex-col gap-1 rounded-md px-2.5 py-1.5 {on ? 'bg-surface-6' : 'hover:bg-surface-4'}"
				>
					<span class="flex items-baseline justify-between gap-3">
						<span class="truncate font-mono text-[12px] {on ? 'text-zinc-100' : 'text-zinc-300'}" title={session.id}>{session.id}</span>
						<span class="flex-none text-[12px] text-zinc-300 tabular-nums">
							{sort === 'spend' ? fmtSpend(session.cost) : sort === 'turns' ? `${fmt(session.turns)} turns` : minutes(session.minutes)}
						</span>
					</span>
					<span class="h-[2px] w-full rounded-full bg-surface-4">
						<span class="block h-full rounded-full bg-emerald-500/70" style:width={`${topMeasure > 0 ? (measure(session) / topMeasure) * 100 : 0}%`}></span>
					</span>
				</a>
			{/each}

			<div class="px-2.5 py-2">
				<ToolbarButton onclick={() => {}}>Show more ({fmt(TOTAL_SESSIONS - sessions.length)} left)</ToolbarButton>
			</div>
		</div>
	</nav>
	</div>

	<div class="flex min-w-0 flex-col">
		{#if picked}
			<StatGrid compact columns={5}>
				<StatCard compact label="Spend" value={fmtSpend(pickedSpend)} />
				<StatCard compact label="Turns" value={fmt(picked.turns)} />
				<StatCard compact label="Length" value={minutes(picked.minutes)} />
				<StatCard compact label="Tokens used" value={fmt(picked.tokens)} />
				<StatCard compact label="Users" value={picked.who} />
			</StatGrid>

			<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
				<ChartCard title="Cost by turn" hint="What each request in this session cost, and how much history it sent.">
					{#snippet actions()}{@render turnLegend()}{/snippet}
					{@render turnChart(requests)}
					<p class="pt-1 pb-1 text-[12px] text-zinc-500">
						The last turn sent <span class="text-zinc-200 tabular-nums">{fmt(requests.at(-1)?.context ?? 0)}</span> tokens of history, against
						<span class="text-zinc-200 tabular-nums">{fmt(requests[0]?.context ?? 0)}</span> on the first.
					</p>
				</ChartCard>

				<ChartCard title="Requests" hint="Every turn, in order. Open one in the logs for its payload.">
					<!-- As tall as the chart beside it; scrolls for the rest. Log ids are
					     UUIDv7, so a session's all share their leading time digits; the tail
					     tells them apart. -->
					<div class="flex h-[218px] flex-col gap-0.5 overflow-y-auto">
						<div class="sticky top-0 grid grid-cols-[40px_64px_minmax(0,1fr)_56px_48px_60px_72px] gap-3 bg-surface-1 pb-1 text-[11px] text-zinc-500">
							<span class="text-right">Turn</span><span>At</span><span>Model</span><span class="text-right">In</span><span class="text-right">Out</span><span class="text-right">Cost</span><span>Log</span>
						</div>
						{#each requests as row (row.turn)}
							{@const [provider, model] = row.model.split('/')}
							<div class="grid grid-cols-[40px_64px_minmax(0,1fr)_56px_48px_60px_72px] items-center gap-3 rounded-[4px] py-0.5 hover:bg-surface-6">
								<span class="text-right text-[12.5px] text-zinc-500 tabular-nums">{fmt(row.turn)}</span>
								<span class="text-[12.5px] whitespace-nowrap text-zinc-500 tabular-nums">+{minutes(row.at)}</span>
								<span class="flex min-w-0 items-center gap-[7px]" title={row.model}>
									<span class="size-[7px] flex-none rounded-full" style:background={providerTone(provider ?? '').color}></span>
									<code class="truncate font-mono text-[12px] text-zinc-200"><span class="text-zinc-500">{provider}/</span>{model}</code>
								</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.context)}</span>
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.output)}</span>
								<span class="text-right text-[12.5px] text-zinc-200 tabular-nums">{fmtCost(row.cost)}</span>
								<a href="/logs" title="Open in the logs · {row.id}" aria-label="Open log {row.id}" class="truncate font-mono text-[11.5px] text-sky-400 hover:text-sky-300">{row.id?.slice(-8)}</a>
							</div>
						{/each}
					</div>
				</ChartCard>

				<ChartCard title="Compared with sessions" hint="This session's spend against every session's.">
					<div class="flex min-h-[170px] flex-col gap-3">
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
					</div>
				</ChartCard>

				<ChartCard title="Models" hint="What this session's requests ran on.">
					<div class="flex min-h-[170px] flex-col gap-1">
						<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_56px_64px] gap-3 pb-1 text-[11px] text-zinc-500">
							<span>Model</span><span></span><span class="text-right">Requests</span><span class="text-right">Spend</span>
						</div>
						{#each pickedModels as row (row.model)}
							{@const [provider, model] = row.model.split('/')}
							<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_56px_64px] items-center gap-3">
								<span class="flex min-w-0 items-center gap-[9px]" title={row.model}>
									<span class="size-[7px] shrink-0 rounded-full" style:background={providerTone(provider ?? '').color}></span>
									<span class="truncate text-[12.5px] text-zinc-300"><span class="text-zinc-500">{provider}/</span>{model}</span>
								</span>
								{@render bar(row.cost, pickedModels[0]?.cost ?? 0)}
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.requests)}</span>
								<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.cost)}</span>
							</div>
						{/each}
					</div>
				</ChartCard>
			</div>
		{:else}
			<StatGrid compact columns={5}>
				<StatCard compact label="Sessions" value={fmt(TOTAL_SESSIONS)} comparison={COMPARED} />
				<StatCard compact label="p50 session" value={fmtSpend(0.042)} comparison={{ text: '↑ 8.1%', color: '#fbbf24', title: 'Against the previous 30 days.' }} />
				<StatCard compact label="p95 session" value={fmtSpend(0.61)} comparison={{ text: '↑ 21.0%', color: '#fbbf24', title: 'Against the previous 30 days.' }} />
				<StatCard compact label="Median turns" value="6" comparison={{ text: '↑ 0.5', color: '#60a5fa', title: 'Against the previous 30 days.' }} />
				<StatCard compact label="Median length" value="4m 12s" comparison={{ text: '↓ 3.2%', color: '#a1a1aa', title: 'Against the previous 30 days.' }} />
			</StatGrid>

			<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
				<div class="xl:col-span-2">
					<ChartCard title="Cost by turn" hint="What the nth request in a session costs, on average. History is resent every turn, so later turns cost more.">
						{#snippet actions()}{@render turnLegend()}{/snippet}
						{@render turnChart(turns)}
						<p class="pt-1 pb-1 text-[12px] text-zinc-500">
							Turn 20 costs <span class="text-zinc-200 tabular-nums">{(turnTwenty / firstTurn).toFixed(1)}×</span> turn 1. Trimming or summarizing history after turn 10 would cut the heavy sessions most.
						</p>
					</ChartCard>
				</div>

				<ChartCard title="Cost per session over time" hint="The typical session, and the expensive end.">
					{#snippet actions()}
						<div class="flex items-center gap-3 text-[11.5px] text-zinc-400">
							<span class="flex items-center gap-1.5"><span class="h-[2px] w-3 rounded-full" style:background={ACCENT}></span>Median</span>
							<span class="flex items-center gap-1.5"><span class="h-[2px] w-3 rounded-full" style:background={P95_INK}></span>p95</span>
						</div>
					{/snippet}
					<div bind:clientWidth={dayWidth}>
						<svg width={dayWidth} height={HEIGHT} role="img" aria-label="Median and p95 cost per session per day">
							{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
								{@const y = PAD.top + plotHeight * (1 - tick)}
								<line x1={PAD.left} y1={y} x2={dayWidth - PAD.right} y2={y} stroke={GRID} />
								<text x={PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">{fmtSpend(dayTop * tick)}</text>
							{/each}
							<polyline points={p95Line} fill="none" stroke={P95_INK} stroke-width="1.75" />
							<polyline points={medianLine} fill="none" stroke={ACCENT} stroke-width="1.75" />
							{#each days as row, index (row.day)}
								{#if index % 7 === 0 || index === days.length - 1}
									<text x={PAD.left + daySlot * index} y={HEIGHT - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>{row.day}</text>
								{/if}
							{/each}
						</svg>
					</div>
				</ChartCard>

				<ChartCard title="Cost per session" hint="How many sessions cost how much, and their share of spend.">
					<div class="flex min-h-[190px] flex-col gap-1">
						<div class="grid grid-cols-[72px_minmax(0,1fr)_104px_56px] gap-3 pb-1 text-[11px] text-zinc-500">
							<span>Spend</span><span></span><span class="text-right">Sessions</span><span class="text-right">Of spend</span>
						</div>
						{#each costBands as band (band.label)}
							<div class="grid grid-cols-[72px_minmax(0,1fr)_104px_56px] items-center gap-3">
								<span class="text-[12.5px] text-zinc-300 tabular-nums">{band.label}</span>
								{@render bar(band.sessions, bandSessions)}
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {percent(band.sessions / bandSessions)}</span>
								<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{percent(band.cost / bandCost)}</span>
							</div>
						{/each}
						<p class="pt-1 text-[11.5px] text-zinc-500">The 4% of sessions over $1 are 63% of spend.</p>
					</div>
				</ChartCard>

				<ChartCard title="Turns per session" hint="How many requests a session takes.">
					<div class="flex min-h-[190px] flex-col gap-1">
						{#each turnBands as band (band.label)}
							<div class="grid grid-cols-[72px_minmax(0,1fr)_104px] items-center gap-3">
								<span class="text-[12.5px] text-zinc-300 tabular-nums">{band.label}</span>
								{@render bar(band.sessions, bandSessions)}
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(band.sessions)} · {percent(band.sessions / bandSessions)}</span>
							</div>
						{/each}
						<p class="pt-1 text-[11.5px] text-zinc-500">29% of sessions are a single request - likely one-off calls rather than chats.</p>
					</div>
				</ChartCard>

				<ChartCard title="Apps" hint="Which API keys the sessions came through, and what a typical one costs.">
					<div class="flex min-h-[190px] flex-col gap-1">
						<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_64px_64px] gap-3 pb-1 text-[11px] text-zinc-500">
							<span>App</span><span></span><span class="text-right">Sessions</span><span class="text-right">Median</span>
						</div>
						{#each apps as app (app.name)}
							<div class="grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_64px_64px] items-center gap-3">
								<span class="truncate text-[12.5px] text-zinc-300">{app.name}</span>
								{@render bar(app.sessions, topAppSessions)}
								<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(app.sessions)}</span>
								<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(app.median)}</span>
							</div>
						{/each}
						<p class="pt-1 text-[11.5px] text-zinc-500">docs-assistant sessions cost 1.5× support-chat's at the median.</p>
					</div>
				</ChartCard>
			</div>
		{/if}
	</div>
</div>

{#snippet turnLegend()}
	<div class="flex items-center gap-3 text-[11.5px] text-zinc-400">
		<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={ACCENT}></span>Cost per request</span>
		<span class="flex items-center gap-1.5"><span class="h-[2px] w-3 rounded-full" style:background={INPUT_INK}></span>Context in</span>
	</div>
{/snippet}

<!-- Bars for cost per turn, a line for the history sent, on two axes. -->
{#snippet turnChart(turnRows: TurnRow[])}
	{@const rows = binTurns(turnRows)}
	{@const costTop = Math.max(...rows.map((row) => row.cost)) * 1.1}
	{@const contextTop = Math.max(...rows.map((row) => row.context)) * 1.1}
	{@const slot = (turnWidth - PAD.left - PAD.right) / Math.max(1, rows.length)}
	<!-- About eight labels whatever the length, and never one crowding the last. -->
	{@const every = Math.max(1, Math.ceil(rows.length / 8))}
	{@const hovered = hoveredTurn === null ? null : rows[hoveredTurn]}
	<div class="relative" bind:clientWidth={turnWidth}>
		<svg width={turnWidth} height={HEIGHT} role="img" aria-label="Cost per request by turn number, with context size">
			{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
				{@const y = PAD.top + plotHeight * (1 - tick)}
				<line x1={PAD.left} y1={y} x2={turnWidth - PAD.right} y2={y} stroke={GRID} />
				<text x={PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">{fmtCost(costTop * tick)}</text>
				<text x={turnWidth - PAD.right + 8} y={y + 3.5} font-size="10" fill={AXIS_INK} class="tabular-nums">{fmt(Math.round(contextTop * tick))}</text>
			{/each}
			{#each rows as row, index (row.turn)}
				{@const height = (row.cost / costTop) * plotHeight}
				<rect
					x={PAD.left + slot * index + slot * 0.18}
					y={PAD.top + plotHeight - height}
					width={slot * 0.64}
					{height}
					rx="2"
					fill={ACCENT}
					opacity={hoveredTurn === null || hoveredTurn === index ? 0.85 : 0.35}
				/>
				{#if (index % every === 0 && rows.length - 1 - index >= every / 2) || index === rows.length - 1}
					<text x={PAD.left + slot * (index + 0.5)} y={HEIGHT - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>{fmt(row.turn)}</text>
				{/if}
			{/each}
			<polyline
				points={rows.map((row, index) => `${PAD.left + slot * (index + 0.5)},${PAD.top + plotHeight * (1 - row.context / contextTop)}`).join(' ')}
				fill="none"
				stroke={INPUT_INK}
				stroke-width="1.75"
			/>
		</svg>
		{#each rows as row, index (row.turn)}
			<button
				type="button"
				class="absolute"
				style:left="{PAD.left + slot * index}px"
				style:top="{PAD.top}px"
				style:width="{slot}px"
				style:height="{plotHeight}px"
				aria-label="{row.last ? `Turns ${row.turn} to ${row.last}` : `Turn ${row.turn}`}: {fmtCost(row.cost)}, {fmt(row.context)} tokens in"
				onmouseenter={() => (hoveredTurn = index)}
				onmouseleave={() => (hoveredTurn = null)}
			></button>
		{/each}
		{#if hovered && hoveredTurn !== null}
			<div
				class="pointer-events-none absolute top-1 z-10 w-48 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-3 py-2 text-[11.5px] shadow-lg"
				style:left="{Math.min(Math.max(PAD.left + slot * (hoveredTurn + 0.5), 100), turnWidth - 100)}px"
			>
				<div class="mb-1 text-zinc-500">
					{hovered.last ? `Turns ${fmt(hovered.turn)} – ${fmt(hovered.last)}` : `Turn ${hovered.turn}`}{hovered.model ? ` · ${hovered.model}` : ''}
				</div>
				<div class="flex justify-between gap-3 text-emerald-400">
					<span>{hovered.sessions !== undefined || hovered.last ? 'Per request' : 'Cost'}</span><span class="tabular-nums">{fmtCost(hovered.cost)}</span>
				</div>
				<div class="flex justify-between gap-3 text-blue-400"><span>Context in</span><span class="tabular-nums">{fmt(hovered.context)}</span></div>
				{#if hovered.sessions !== undefined}
					<div class="flex justify-between gap-3 text-zinc-400"><span>Sessions this long</span><span class="tabular-nums">{fmt(hovered.sessions)}</span></div>
				{/if}
			</div>
		{/if}
	</div>
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
