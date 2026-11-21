<script lang="ts">
import { fetchSeries, type SeriesPoint } from '#lib/api/analytics.ts';
import { alignedNow } from '#lib/components/analytics/analytics-filters.svelte.ts';
import ChartCard from '#lib/components/app/chart-card.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { periodComparison } from '#lib/data/analytics-comparison.ts';
import { axisTop, brokenLinePath } from '#lib/data/chart-series.ts';
import { fmtCostTotal } from '#lib/data/format.ts';
import { spendForecast } from '#lib/data/spend-forecast.ts';
import { Latest } from '#lib/state/latest.svelte.ts';

type View = 'daily' | 'cumulative';

interface Props {
  provider?: string;
  model?: string;
  height?: number;
}

let { provider, model, height: cardHeight = 160 }: Props = $props();

const ACTUAL = '#10b981';
const LAST_MONTH_INK = '#71717a';
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';

// The chart sits under the figures, with a money axis on the left.
const PAD = { top: 10, right: 10, bottom: 22, left: 56 };

// How much of the card's height the figures above the chart take.
const FIGURES_HEIGHT = 44;

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

const VIEWS = [
  { id: 'daily', label: 'Daily' },
  { id: 'cumulative', label: 'Cumulative' },
] satisfies { id: View; label: string }[];

// The days fetched, with the moment they were fetched up to.
const series = new Latest<{ points: SeriesPoint[]; now: Date }>();

let view = $state<View>('daily');
let width = $state(600);
let hovered = $state<number | null>(null);

async function fetchDays(): Promise<{ points: SeriesPoint[]; now: Date }> {
  // From the start of last month, for the comparisons and for a full week of
  // run rate early in the month.
  const end = new Date(alignedNow());
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));

  const [days] = await fetchSeries({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    interval: 'day',
    provider: provider || undefined,
    model: model || undefined,
    groupings: [['bucket']],
  });

  return { points: days, now: end };
}

function load(): void {
  void series.load(fetchDays);
}

$effect(() => {
  void [provider, model];
  load();
});

const loading = $derived(series.loading);
const failed = $derived(series.error !== null);
const points = $derived(series.value?.points ?? []);
const now = $derived(series.value?.now ?? new Date(alignedNow()));
const forecast = $derived(spendForecast(points, now));
const monthName = $derived(MONTH.format(now));
const lastMonthName = $derived(MONTH.format(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

const versusLastMonth = $derived(
  periodComparison(forecast.projected, forecast.lastMonth > 0 ? forecast.lastMonth : null, {
    label: 'last month',
    lowerIsBetter: true,
  }),
);

// The fair comparison from day to day, which is this month so far against last
// month by the same point.
const versusSamePoint = $derived(
  periodComparison(forecast.monthToDate, forecast.lastMonthToDate > 0 ? forecast.lastMonthToDate : null, {
    label: `${lastMonthName} by the same point`,
    lowerIsBetter: true,
  }),
);

const height = $derived(Math.max(80, cardHeight - FIGURES_HEIGHT));
const plotHeight = $derived(height - PAD.top - PAD.bottom);
const days = $derived(forecast.days);
const plotWidth = $derived(Math.max(1, width - PAD.left - PAD.right));
const slot = $derived(plotWidth / Math.max(1, days.length));
const barWidth = $derived(Math.max(2, Math.min(18, slot * 0.7)));

const axisMax = $derived.by(() => {
  const values =
    view === 'daily'
      ? days.map((day) => day.actual ?? day.projected ?? 0)
      : days.flatMap((day) => [day.cumulative ?? 0, day.projectedCumulative ?? 0, day.lastMonthCumulative ?? 0]);

  return axisTop(Math.max(0, ...values));
});

function x(index: number): number {
  return PAD.left + slot * (index + 0.5);
}

function y(value: number): number {
  return PAD.top + plotHeight - (value / axisMax) * plotHeight;
}

const actualPath = $derived(
  brokenLinePath(
    days.map((day) => day.cumulative),
    x,
    y,
  ),
);
const projectedPath = $derived(
  brokenLinePath(
    days.map((day) => day.projectedCumulative),
    x,
    y,
  ),
);
const lastMonthPath = $derived(
  brokenLinePath(
    days.map((day) => day.lastMonthCumulative),
    x,
    y,
  ),
);
const selected = $derived(hovered === null ? null : days[hovered]);

// A new response or view clears the tooltip.
$effect(() => {
  void points;
  void view;
  hovered = null;
});
</script>

<ChartCard
	title="This month"
	hint={view === 'daily' ? "Each day's spend; the rest at the last 7 days' pace." : `Running total against ${lastMonthName}'s, projected at the last 7 days' pace.`}
>
	{#snippet actions()}<FilterTabs tabs={VIEWS} bind:value={view} />{/snippet}
	<div class="flex flex-col">
		<div class="flex h-[44px] items-start gap-6">
			<div>
				<div class="text-[11px] text-zinc-500">{monthName} to date</div>
				<div class="flex items-baseline gap-2">
					<span class="text-[17px] font-semibold text-zinc-100 tabular-nums">{loading ? '—' : fmtCostTotal(forecast.monthToDate)}</span>
					{#if !loading && forecast.lastMonthToDate > 0}
						<span
							class="text-[11.5px] whitespace-nowrap tabular-nums"
							style:color={versusSamePoint.color}
							title="{lastMonthName} had reached {fmtCostTotal(forecast.lastMonthToDate)} by this point in the month. {versusSamePoint.title}"
						>
							{versusSamePoint.text} vs {fmtCostTotal(forecast.lastMonthToDate)}
						</span>
					{/if}
				</div>
			</div>
			<div>
				<div class="text-[11px] text-zinc-500">Projected</div>
				<div class="text-[17px] font-semibold text-zinc-300 tabular-nums">
					{loading || forecast.projected === null ? '—' : fmtCostTotal(forecast.projected)}
				</div>
			</div>
			<div>
				<div class="text-[11px] text-zinc-500">{lastMonthName} total</div>
				<div class="flex items-baseline gap-2">
					<span class="text-[17px] font-semibold text-zinc-400 tabular-nums">{loading ? '—' : fmtCostTotal(forecast.lastMonth)}</span>
					{#if !loading && forecast.projected !== null && forecast.lastMonth > 0}
						<span class="text-[11.5px] tabular-nums" style:color={versusLastMonth.color} title={versusLastMonth.title}>{versusLastMonth.text}</span>
					{/if}
				</div>
			</div>
		</div>

		<div class="relative" bind:clientWidth={width}>
			{#if view === 'cumulative'}
				<div class="pointer-events-none absolute top-0 right-2 flex items-center gap-3 text-[10px] text-zinc-400">
					<span class="flex items-center gap-1.5"><span class="h-[2px] w-3" style:background={ACTUAL}></span>{monthName}</span>
					<span class="flex items-center gap-1.5"><span class="h-0 w-3 border-t-2 border-dashed" style:border-color={ACTUAL}></span>Projected</span>
					<span class="flex items-center gap-1.5"><span class="h-[2px] w-3" style:background={LAST_MONTH_INK}></span>{lastMonthName}</span>
				</div>
			{/if}
			{#if loading}
				<div class="flex items-center justify-center text-[12.5px] text-zinc-600" style:height="{height}px">Loading spend…</div>
			{:else if failed}
				<div class="flex items-center justify-center gap-2 text-[12.5px] text-zinc-500" style:height="{height}px" role="status">
					Couldn't load this month's spend.
					<ToolbarButton onclick={load}>Retry</ToolbarButton>
				</div>
			{:else}
				<svg
					{width}
					height={height}
					role="img"
					aria-label={view === 'daily' ? `Daily spend in ${monthName}, with the rest of the month projected` : `Running total for ${monthName} against ${lastMonthName}, projected to month end`}
				>
					{#each [0, 0.5, 1] as tick (tick)}
						{@const lineY = PAD.top + plotHeight * (1 - tick)}
						<line x1={PAD.left} y1={lineY} x2={width - PAD.right} y2={lineY} stroke={GRID} />
						<text x={PAD.left - 8} y={lineY + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">{fmtCostTotal(axisMax * tick)}</text>
					{/each}

					{#if view === 'daily'}
						{#each days as day, index (day.date.getTime())}
							{@const value = day.actual ?? day.projected ?? 0}
							{@const barHeight = (value / axisMax) * plotHeight}
							<rect
								x={x(index) - barWidth / 2}
								y={PAD.top + plotHeight - barHeight}
								width={barWidth}
								height={barHeight}
								rx="1.5"
								fill={ACTUAL}
								opacity={(day.actual === null ? 0.25 : 1) * (hovered === null || hovered === index ? 1 : 0.5)}
							/>
						{/each}
					{:else}
						<path d={lastMonthPath} fill="none" stroke={LAST_MONTH_INK} stroke-width="1.5" stroke-linejoin="round" />
						<path d={projectedPath} fill="none" stroke={ACTUAL} stroke-width="1.6" stroke-dasharray="4 3" opacity="0.7" />
						<path d={actualPath} fill="none" stroke={ACTUAL} stroke-width="1.8" stroke-linejoin="round" />
						{#if hovered !== null && selected}
							<line x1={x(hovered)} y1={PAD.top} x2={x(hovered)} y2={PAD.top + plotHeight} stroke="#3f3f46" stroke-dasharray="3 3" />
							{#if (selected.cumulative ?? selected.projectedCumulative) !== null}
								<circle cx={x(hovered)} cy={y(selected.cumulative ?? selected.projectedCumulative ?? 0)} r="3.5" fill={ACTUAL} />
							{/if}
							{#if selected.lastMonthCumulative !== null}
								<circle cx={x(hovered)} cy={y(selected.lastMonthCumulative)} r="3" fill={LAST_MONTH_INK} />
							{/if}
						{/if}
					{/if}

					{#each days as day, index (day.date.getTime())}
						{#if index === 0 || (index + 1) % 7 === 0}
							<text x={x(index)} y={height - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>{index + 1}</text>
						{/if}
					{/each}
				</svg>

				{#each days as day, index (day.date.getTime())}
					<button
						type="button"
						class="absolute focus-visible:outline-2 focus-visible:outline-sky-400"
						style:left="{PAD.left + slot * index}px"
						style:top="{PAD.top}px"
						style:width="{slot}px"
						style:height="{plotHeight}px"
						aria-label="{monthName} {index + 1}: {day.actual === null ? `about ${fmtCostTotal(day.projected ?? 0)} at the current pace` : `${fmtCostTotal(day.actual)} spent, ${fmtCostTotal(day.cumulative ?? 0)} so far`}"
						onmouseenter={() => (hovered = index)}
						onmouseleave={() => (hovered = null)}
						onfocus={() => (hovered = index)}
						onblur={() => (hovered = null)}
					></button>
				{/each}

				{#if selected && hovered !== null}
					<div
						class="pointer-events-none absolute top-0 z-10 w-48 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-3 py-2 text-[11.5px] shadow-lg"
						style:left="{Math.min(Math.max(x(hovered), 96), Math.max(96, width - 96))}px"
					>
						<div class="mb-1 text-zinc-500">{monthName} {hovered + 1}{selected.actual === null ? ' · projected' : ''}</div>
						<div class="flex justify-between gap-3 text-emerald-400">
							<span>{selected.actual === null ? 'At current pace' : 'Spent'}</span>
							<span class="tabular-nums">{fmtCostTotal(selected.actual ?? selected.projected ?? 0)}</span>
						</div>
						<div class="flex justify-between gap-3 text-zinc-300">
							<span>Month so far</span>
							<span class="tabular-nums">{fmtCostTotal(selected.cumulative ?? selected.projectedCumulative ?? 0)}</span>
						</div>
						{#if selected.lastMonthCumulative !== null}
							<div class="mt-1 flex justify-between gap-3 border-t border-line pt-1 text-zinc-400">
								<span>{lastMonthName} by then</span>
								<span class="tabular-nums">{fmtCostTotal(selected.lastMonthCumulative)}</span>
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</ChartCard>
