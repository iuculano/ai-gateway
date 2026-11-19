<script lang="ts">
import { fetchSeries, type SeriesPoint } from '$lib/api/analytics';
import { alignedNow } from '$lib/components/analytics/analytics-filters.svelte';
import ChartCard from '$lib/components/app/chart-card.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { periodComparison } from '$lib/data/analytics-comparison';
import { fmtCostTotal } from '$lib/data/format';
import { spendForecast } from '$lib/data/spend-forecast';

/**
 * This calendar month's spend and where it's heading. Always the current month,
 * whatever range the rest of the page shows, but narrowed by its provider and
 * model filters.
 *
 * Daily shows each day's spend, then the run rate for the days to come.
 * Cumulative is the budget view: the month's running total against last
 * month's, with the projected path to month end.
 */
let { provider, model, height: chartHeight = 160 }: { provider?: string; model?: string; height?: number } = $props();

const ACTUAL = '#10b981';
const LAST_MONTH_INK = '#71717a';
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let points = $state<SeriesPoint[]>([]);
let now = $state(new Date(alignedNow()));
let loading = $state(true);
let failed = $state(false);
let request = 0;

let view = $state<'daily' | 'cumulative'>('daily');
const views = [
  { id: 'daily', label: 'Daily' },
  { id: 'cumulative', label: 'Cumulative' },
] satisfies { id: typeof view; label: string }[];

async function load() {
  const current = ++request;
  loading = true;
  failed = false;

  // From the start of last month, for the comparisons and a full week of run
  // rate early in the month.
  const end = new Date(alignedNow());
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));

  try {
    const [days] = await fetchSeries({
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      interval: 'day',
      provider: provider || undefined,
      model: model || undefined,
      groupings: [['bucket']],
    });
    if (current !== request) return;
    points = days;
    now = end;
  } catch {
    if (current === request) failed = true;
  } finally {
    if (current === request) loading = false;
  }
}

$effect(() => {
  void [provider, model];
  void load();
});

const forecast = $derived(spendForecast(points, now));
const monthName = $derived(MONTHS[now.getUTCMonth()]);
const lastMonthName = $derived(MONTHS[(now.getUTCMonth() + 11) % 12]);
const versusLastMonth = $derived(
  periodComparison(forecast.projected, forecast.lastMonth > 0 ? forecast.lastMonth : null, {
    label: 'last month',
    lowerIsBetter: true,
  }),
);
// The fair day-to-day comparison: this month so far against last month by the
// same point.
const versusSamePoint = $derived(
  periodComparison(forecast.monthToDate, forecast.lastMonthToDate > 0 ? forecast.lastMonthToDate : null, {
    label: `${lastMonthName} by the same point`,
    lowerIsBetter: true,
  }),
);

// The chart, under the figures, with a money axis on the left.
const PAD = { top: 10, right: 10, bottom: 22, left: 56 };
// The figures above the chart take this much of the card's height.
const FIGURES_H = 44;
const HEIGHT = $derived(Math.max(80, chartHeight - FIGURES_H));
const plotHeight = $derived(HEIGHT - PAD.top - PAD.bottom);
let width = $state(600);
let hovered = $state<number | null>(null);

const days = $derived(forecast.days);
const plotWidth = $derived(Math.max(1, width - PAD.left - PAD.right));
const slot = $derived(plotWidth / Math.max(1, days.length));
const barWidth = $derived(Math.max(2, Math.min(18, slot * 0.7)));

// Rounded up so the gridlines land on round amounts.
const axisTop = $derived.by(() => {
  const values =
    view === 'daily'
      ? days.map((day) => day.actual ?? day.projected ?? 0)
      : days.flatMap((day) => [day.cumulative ?? 0, day.projectedCumulative ?? 0, day.lastMonthCumulative ?? 0]);
  const peak = Math.max(0, ...values);
  if (peak === 0) return 1;
  const step = 10 ** Math.floor(Math.log10(peak)) / 2;
  return Math.ceil(peak / step) * step;
});

const x = (index: number) => PAD.left + slot * (index + 0.5);
const y = (value: number) => PAD.top + plotHeight - (value / axisTop) * plotHeight;

/** An SVG path through one of the day series, lifting the pen over gaps. */
function pathOf(values: (number | null)[]) {
  let path = '';
  let drawing = false;
  for (const [index, value] of values.entries()) {
    if (value === null) {
      drawing = false;
      continue;
    }
    path += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
    drawing = true;
  }
  return path;
}

const actualPath = $derived(pathOf(days.map((day) => day.cumulative)));
const projectedPath = $derived(pathOf(days.map((day) => day.projectedCumulative)));
const lastMonthPath = $derived(pathOf(days.map((day) => day.lastMonthCumulative)));
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
	{#snippet actions()}<FilterTabs tabs={views} bind:value={view} />{/snippet}
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
				<div class="flex items-center justify-center text-[12.5px] text-zinc-600" style:height="{HEIGHT}px">Loading spend…</div>
			{:else if failed}
				<div class="flex items-center justify-center gap-2 text-[12.5px] text-zinc-500" style:height="{HEIGHT}px" role="status">
					Couldn't load this month's spend.
					<ToolbarButton onclick={load}>Retry</ToolbarButton>
				</div>
			{:else}
				<svg
					{width}
					height={HEIGHT}
					role="img"
					aria-label={view === 'daily' ? `Daily spend in ${monthName}, with the rest of the month projected` : `Running total for ${monthName} against ${lastMonthName}, projected to month end`}
				>
					{#each [0, 0.5, 1] as tick (tick)}
						{@const lineY = PAD.top + plotHeight * (1 - tick)}
						<line x1={PAD.left} y1={lineY} x2={width - PAD.right} y2={lineY} stroke={GRID} />
						<text x={PAD.left - 8} y={lineY + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">{fmtCostTotal(axisTop * tick)}</text>
					{/each}

					{#if view === 'daily'}
						{#each days as day, index (day.date.getTime())}
							{@const value = day.actual ?? day.projected ?? 0}
							{@const height = (value / axisTop) * plotHeight}
							<rect
								x={x(index) - barWidth / 2}
								y={PAD.top + plotHeight - height}
								width={barWidth}
								{height}
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
							<text x={x(index)} y={HEIGHT - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>{index + 1}</text>
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
