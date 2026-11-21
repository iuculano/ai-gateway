<script lang="ts">
import {
  type AnalyticsInterval,
  fetchSeries,
  fetchSessions,
  fetchTokens,
  type SeriesPoint,
  type SessionsResponse,
  type TokensResponse,
} from '#lib/api/analytics.ts';
import { windowBefore, windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import SpendChart from '#lib/components/analytics/spend-chart.svelte';
import ChartCard from '#lib/components/app/chart-card.svelte';
import StatCard from '#lib/components/app/stat-card.svelte';
import StatGrid from '#lib/components/app/stat-grid.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { headlineComparisons, headlineFigures, unavailableComparisons } from '#lib/data/analytics-comparison.ts';
import { fmt, fmtBucket, fmtCostTotal, fmtPercent, fmtSpend, providerTone } from '#lib/data/format.ts';
import { percentileAt, percentileRank } from '#lib/data/percentiles.ts';
import { tokenBand } from '#lib/data/users.ts';
import { Latest } from '#lib/state/latest.svelte.ts';

interface Props {
  userId?: string;
  actorId?: string;
  days: number;
  interval: AnalyticsInterval;
  activeUsers: number | null;
  costPercentiles: number[] | null;
}

let { userId, actorId, days, interval, activeUsers, costPercentiles }: Props = $props();

const ACCENT = '#10b981';
const MUTED = '#52525b';

// The same inks as the overview's spend chart.
const INPUT_INK = '#60a5fa';
const OUTPUT_INK = '#a78bfa';

// Rows per list, most expensive first.
const ROWS = 5;

// The list cards, with a name, a bar against the biggest, requests and spend.
const ROW_GRID = 'grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_56px_64px] items-center gap-3';

// The same with a tokens column.
const LIST_GRID = 'grid grid-cols-[minmax(80px,1.2fr)_minmax(0,1fr)_52px_52px_60px] items-center gap-3';

// The points along the spread that the everyone view's card shows.
const SPREAD = [
  { label: 'Median user', percentile: 50 },
  { label: 'p75', percentile: 75 },
  { label: 'p90', percentile: 90 },
  { label: 'p95', percentile: 95 },
  { label: 'p99', percentile: 99 },
];

interface Pane {
  totals: SeriesPoint | null;
  timeline: SeriesPoint[];
  models: SeriesPoint[];
  apps: SeriesPoint[];
  statuses: SeriesPoint[];
  sessions: SessionsResponse;
  tokenUsage: TokensResponse;
  previous: { totals: SeriesPoint | null; statuses: SeriesPoint[]; models: SeriesPoint[] } | null;
}

const pane = new Latest<Pane>();

async function fetchPane(): Promise<Pane> {
  const range = windowOf(days);
  const scope = { ...range, actor_id: actorId, user_id: userId };

  const [[total, byBucket, byModel, byApp, byStatus], sessions, tokenUsage, earlier] = await Promise.all([
    fetchSeries({
      ...scope,
      interval: interval,
      groupings: [[], ['bucket'], ['provider', 'model'], ['actor'], ['status']],
    }),
    fetchSessions({ ...scope, limit: ROWS }),
    fetchTokens(scope),

    // The window before, as the overview compares against it. Caught here,
    // because a failure in it must not hide this window's figures.
    fetchSeries({ ...scope, ...windowBefore(days), groupings: [[], ['status'], ['provider', 'model']] }).catch(
      () => null,
    ),
  ]);

  return {
    totals: total[0] ?? null,
    timeline: byBucket,
    models: byModel.toSorted((a, b) => b.cost_total - a.cost_total),
    apps: byApp.toSorted((a, b) => b.cost_total - a.cost_total),
    statuses: byStatus,
    sessions: sessions,
    tokenUsage: tokenUsage,
    previous: earlier && { totals: earlier[0][0] ?? null, statuses: earlier[1], models: earlier[2] },
  };
}

function load(): void {
  void pane.load(fetchPane);
}

$effect(() => {
  void [userId, actorId, days, interval];
  load();
});

const loading = $derived(pane.loading);
const failed = $derived(pane.error !== null);
const totals = $derived(pane.value?.totals ?? null);
const timeline = $derived(pane.value?.timeline ?? []);
const models = $derived(pane.value?.models ?? []);
const apps = $derived(pane.value?.apps ?? []);
const statuses = $derived(pane.value?.statuses ?? []);
const sessions = $derived(pane.value?.sessions ?? null);
const tokenUsage = $derived(pane.value?.tokenUsage ?? null);
const previous = $derived(pane.value?.previous ?? null);
const previousModels = $derived(previous?.models ?? null);

// Only the first load shows placeholders. After that the last numbers stay up,
// dimmed, until the next ones arrive, so that picking a user does not flash the
// pane.
const first = $derived(loading && pane.value === null);
const headline = $derived(headlineFigures(totals, statuses));
const rangeLabel = $derived(days === 1 ? 'Last 24 hours' : `Last ${days} days`);
const comparisonLabel = $derived(`the previous ${days === 1 ? '24 hours' : `${days} days`}`);

// Each figure against the window before, as on the overview.
const comparisons = $derived(
  previous
    ? headlineComparisons(headline, headlineFigures(previous.totals, previous.statuses), comparisonLabel)
    : unavailableComparisons(comparisonLabel),
);

// One user's spend placed among everyone's, as the share of users who spent
// less.
const userSpend = $derived(totals?.cost_total ?? 0);
const spendsMoreThan = $derived(costPercentiles?.length ? percentileRank(costPercentiles, userSpend) : null);
const comparison = $derived([
  { label: 'This user', value: userSpend, color: ACCENT },
  { label: 'Median user', value: percentileAt(costPercentiles ?? [], 50), color: MUTED },
  { label: 'p95 user', value: percentileAt(costPercentiles ?? [], 95), color: MUTED },
]);
const comparisonTop = $derived(Math.max(0, ...comparison.map((row) => row.value)));

const spendLevels = $derived(
  SPREAD.map((level) => ({ label: level.label, value: percentileAt(costPercentiles ?? [], level.percentile) })),
);

const topModel = $derived(models[0]);
const topModelShare = $derived(topModel && userSpend > 0 ? topModel.cost_total / userSpend : null);
const topSessions = $derived(sessions?.top ?? []);
const topSessionSpend = $derived(topSessions[0]?.cost_total ?? 0);
const topAppSpend = $derived(apps[0]?.cost_total ?? 0);

// The tokens card covers only the requests a provider answered, since a
// gateway cache hit reached none.
const tokenTotal = $derived((tokenUsage?.input_tokens ?? 0) + (tokenUsage?.output_tokens ?? 0));
const costPerMillion = $derived(tokenTotal > 0 ? ((totals?.cost_total ?? 0) / tokenTotal) * 1_000_000 : null);
const tokenSides = $derived(
  tokenUsage
    ? [
        {
          title: 'Context in',
          ink: INPUT_INK,
          median: tokenUsage.median_input_tokens,
          p95: tokenUsage.p95_input_tokens,
          bands: tokenUsage.input_bands,
        },
        {
          title: 'Answer out',
          ink: OUTPUT_INK,
          median: tokenUsage.median_output_tokens,
          p95: tokenUsage.p95_output_tokens,
          bands: tokenUsage.output_bands,
        },
      ]
    : [],
);
</script>

<!-- No gap of its own, because StatGrid already leaves the same space under it
     as on every tab. -->
<div class="flex min-w-0 flex-col transition-opacity" style:opacity={loading && !first ? 0.6 : 1} aria-busy={loading}>
	<StatGrid compact columns={5}>
		<StatCard compact label="Spend" value={first ? '—' : fmtSpend(totals?.cost_total ?? 0)} comparison={first ? undefined : comparisons.spend} />
		{#if userId}
			<StatCard compact label="Requests" value={first ? '—' : fmt(headline.requests)} comparison={first ? undefined : comparisons.requests} />
		{:else}
			<StatCard compact label="Active users" value={activeUsers === null ? '—' : fmt(activeUsers)} />
		{/if}
		<StatCard compact label="Sessions" value={first ? '—' : fmt(sessions?.count ?? 0)} />
		<StatCard compact label="Tokens used" value={first ? '—' : fmt(totals?.total_tokens ?? 0)} comparison={first ? undefined : comparisons.tokens} />
		<StatCard
			compact
			label="Error rate"
			value={first ? '—' : `${(headline.errorRate ?? 0).toFixed(2)}%`}
			comparison={first ? undefined : comparisons.errorRate}
		/>
	</StatGrid>

	{#if failed}
		<div class="mb-[var(--analytics-gap)] flex items-center justify-between gap-2 text-[12.5px] text-zinc-500" role="status">
			<span>Couldn't load {userId ?? 'users'}.</span>
			<ToolbarButton onclick={load}>Retry</ToolbarButton>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
		<SpendChart
			points={timeline}
			loading={first}
			{interval}
			{rangeLabel}
			bucketLabel={(bucket) => fmtBucket(bucket, interval)}
			modelPoints={models}
			previousModelPoints={previousModels}
			{comparisonLabel}
			comparisonUnavailable={previousModels === null}
			onretry={load}
		/>

		{#if userId}
			<ChartCard title="Compared with everyone" hint={actorId ? 'Against the selected app’s users.' : 'This user’s spend against every user’s.'}>
				<div class="min-h-[170px] flex flex-col gap-3">
					{#if first || costPercentiles === null}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading…</div>
					{:else if spendsMoreThan === null}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">No users to compare with in this window.</div>
					{:else}
						<div>
							<div class="text-[15px] text-zinc-200">
								Spends more than <span class="font-semibold text-zinc-50 tabular-nums">{spendsMoreThan}%</span> of users
							</div>
							<!-- Where they sit, 0 to 100. -->
							<div class="relative mt-2 h-[6px] w-full rounded-full bg-surface-4">
								<div class="absolute top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1" style:left="{spendsMoreThan}%" style:background={ACCENT}></div>
							</div>
						</div>
						<div class="flex flex-col gap-1">
							{#each comparison as row (row.label)}
								<div class="grid grid-cols-[88px_minmax(0,1fr)_64px] items-center gap-3">
									<span class="text-[12.5px] text-zinc-400">{row.label}</span>
									<div class="h-[18px] w-full">
										<div class="h-full rounded-r-[4px]" style:width={`${comparisonTop > 0 ? (row.value / comparisonTop) * 100 : 0}%`} style:background={row.color}></div>
									</div>
									<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.value)}</span>
								</div>
							{/each}
						</div>
						{#if topModel}
							<p class="text-[12px] text-zinc-500">
								Mostly <span class="text-zinc-300">{topModel.provider}/{topModel.model}</span>{#if topModelShare !== null}, {Math.round(topModelShare * 100)}% of their spend{/if}.
							</p>
						{/if}
					{/if}
				</div>
			</ChartCard>
		{:else}
			<ChartCard title="Spend per user" hint={actorId ? 'What the selected app’s users spend.' : 'What a typical user spends, and the heavy end.'}>
				<div class="min-h-[170px] flex flex-col gap-1">
					{#if costPercentiles === null}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading…</div>
					{:else if costPercentiles.length === 0}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests tagged with a user in this window.</div>
					{:else}
						{#each spendLevels as level (level.label)}
							<div class="grid grid-cols-[88px_minmax(0,1fr)_64px] items-center gap-3">
								<span class="text-[12.5px] text-zinc-400">{level.label}</span>
								{@render bar(level.value, spendLevels.at(-1)?.value ?? 0)}
								<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(level.value)}</span>
							</div>
						{/each}
						<p class="pt-1 text-[11.5px] text-zinc-500">
							Half of users spend under {fmtSpend(percentileAt(costPercentiles, 50))}; the top 1% over {fmtSpend(percentileAt(costPercentiles, 99))}.
						</p>
					{/if}
				</div>
			</ChartCard>
		{/if}

		<ChartCard title="Models" hint={userId ? 'What this user’s requests ran on.' : 'What requests ran on.'}>
			<div class="min-h-[170px] flex flex-col gap-1">
				{#if first}
					<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading models…</div>
				{:else}
					{@render columns(LIST_GRID, ['Model', '', 'Requests', 'Tokens', 'Spend'])}
					{#each models.slice(0, ROWS) as row (`${row.provider}/${row.model}`)}
						<div class={LIST_GRID}>
							<span class="flex min-w-0 items-center gap-[9px]" title={`${row.provider}/${row.model}`}>
								<span class="size-[7px] shrink-0 rounded-full" style:background={providerTone(row.provider ?? '').color}></span>
								<span class="truncate text-[12.5px] text-zinc-300"><span class="text-zinc-500">{row.provider}/</span>{row.model}</span>
							</span>
							{@render bar(row.cost_total, models[0]?.cost_total ?? 0)}
							<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.requests)}</span>
							<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.total_tokens)}</span>
							<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.cost_total)}</span>
						</div>
					{:else}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
					{/each}
					{#if models.length > ROWS}<p class="pt-1 text-[11px] text-zinc-600">Top {ROWS} of {fmt(models.length)}</p>{/if}
				{/if}
			</div>
		</ChartCard>

		<ChartCard title="Tokens" hint="Processed by providers; gateway cache hits are left out.">
			<div class="min-h-[170px] flex flex-col gap-3">
				{#if first || !tokenUsage}
					<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading tokens…</div>
				{:else if tokenUsage.requests === 0}
					<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
				{:else}
					<!-- In against out, how much of the input came from the prompt cache, and the price of the mix. -->
					<div class="flex flex-col gap-1.5">
						<div class="flex h-[8px] w-full overflow-hidden rounded-full bg-surface-4">
							<div style:width="{tokenTotal > 0 ? (tokenUsage.input_tokens / tokenTotal) * 100 : 0}%" style:background={INPUT_INK}></div>
							<div style:width="{tokenTotal > 0 ? (tokenUsage.output_tokens / tokenTotal) * 100 : 0}%" style:background={OUTPUT_INK}></div>
						</div>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
							<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={INPUT_INK}></span>In <span class="text-zinc-200 tabular-nums">{fmt(tokenUsage.input_tokens)}</span></span>
							<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={OUTPUT_INK}></span>Out <span class="text-zinc-200 tabular-nums">{fmt(tokenUsage.output_tokens)}</span></span>
							<span title="Input tokens the provider served from its prompt cache">
								<span class="text-zinc-200 tabular-nums">{fmtPercent(tokenUsage.input_tokens > 0 ? tokenUsage.cached_input_tokens / tokenUsage.input_tokens : 0)}</span> of input from prompt cache
							</span>
							{#if costPerMillion !== null}
								<span><span class="text-zinc-200 tabular-nums">{fmtCostTotal(costPerMillion)}</span> per 1M tokens</span>
							{/if}
						</div>
					</div>
					<!-- How big requests and answers are, with each request counted into a size band. -->
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						{#each tokenSides as side (side.title)}
							<div class="flex flex-col gap-1">
								<div class="flex items-baseline justify-between gap-2 text-[11.5px] text-zinc-500">
									<span>{side.title}</span>
									<span class="tabular-nums">median {fmt(Math.round(side.median ?? 0))} · p95 {fmt(Math.round(side.p95 ?? 0))}</span>
								</div>
								{#each side.bands as band (band.min)}
									<div class="grid grid-cols-[64px_minmax(0,1fr)_40px] items-center gap-2">
										<span class="text-[11.5px] text-zinc-400 tabular-nums">{tokenBand(band.min, band.max)}</span>
										<div class="h-[10px] w-full">
											<div class="h-full rounded-r-[3px]" style:width="{(band.requests / tokenUsage.requests) * 100}%" style:background={side.ink}></div>
										</div>
										<span class="text-right text-[11.5px] text-zinc-400 tabular-nums">{fmtPercent(band.requests / tokenUsage.requests)}</span>
									</div>
								{/each}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</ChartCard>

		<ChartCard title="Top sessions" hint="By spend, from the session_id tag.">
			<div class="min-h-[170px] flex flex-col gap-1">
				{#if first}
					<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading sessions…</div>
				{:else}
					{@render columns(LIST_GRID, ['Session', '', 'Requests', 'Tokens', 'Spend'])}
					{#each topSessions as row (row.session_id)}
						<!-- Who took part, as the one user or how many shared it. -->
						{@const who = row.user_id || (row.users > 1 ? `${fmt(row.users)} users` : '')}
						<div class={LIST_GRID}>
							<span class="min-w-0 truncate text-[12.5px]" title={who ? `${row.session_id} · ${who}` : row.session_id}>
								<span class="font-mono text-[12px] text-zinc-300">{row.session_id}</span>
								{#if !userId && who}<span class="text-zinc-500"> · {who}</span>{/if}
							</span>
							{@render bar(row.cost_total, topSessionSpend)}
							<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.requests)}</span>
							<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.tokens)}</span>
							<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.cost_total)}</span>
						</div>
					{:else}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">
							No sessions in this window. Send <code class="text-zinc-400">ai-log-tags: session_id:…</code> to group requests.
						</div>
					{/each}
					{#if (sessions?.count ?? 0) > ROWS}<p class="pt-1 text-[11px] text-zinc-600">Top {ROWS} of {fmt(sessions?.count ?? 0)}</p>{/if}
				{/if}
			</div>
		</ChartCard>

		<ChartCard title="Apps" hint={actorId ? 'Narrowed to one app.' : 'The API keys requests came through. Pick one to see its users.'}>
			<div class="min-h-[170px] flex flex-col gap-1">
				{#if first}
					<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading apps…</div>
				{:else}
					{@render columns(ROW_GRID, ['App', '', 'Requests', 'Spend'])}
					{#each apps.slice(0, ROWS) as row (row.actor_id)}
						<a href="/analytics/users?actor={row.actor_id}" class="{ROW_GRID} rounded-[4px] hover:bg-surface-6" title="See the users of {row.actor_label ?? 'this app'}">
							<span class="flex min-w-0 items-center gap-1.5">
								<!-- The kind of credential, as on the overview's top callers. -->
								<span class="w-11 flex-none rounded-[3px] px-1 py-[1px] text-center text-[9.5px] tracking-wide uppercase {row.actor_type === 'api_key' ? 'bg-sky-500/12 text-sky-300/80' : 'bg-violet-500/12 text-violet-300/80'}">
									{row.actor_type === 'api_key' ? 'key' : row.actor_type}
								</span>
								<span class="truncate text-[12.5px] text-zinc-300">{row.actor_label ?? 'Unknown'}</span>
							</span>
							{@render bar(row.cost_total, topAppSpend)}
							<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmt(row.requests)}</span>
							<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmtSpend(row.cost_total)}</span>
						</a>
					{:else}
						<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
					{/each}
					{#if apps.length > ROWS}<p class="pt-1 text-[11px] text-zinc-600">Top {ROWS} of {fmt(apps.length)}</p>{/if}
				{/if}
			</div>
		</ChartCard>
	</div>
</div>

<!-- The header over a list card's rows, with the first name on the left and the
     rest right-aligned. -->
{#snippet columns(grid: string, names: string[])}
	<div class="{grid} pb-1 text-[11px] text-zinc-500">
		{#each names as name, index (index)}<span class={index > 1 ? 'text-right' : ''}>{name}</span>{/each}
	</div>
{/snippet}

<!-- A row's bar, against the biggest in its list, as on the overview. -->
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
