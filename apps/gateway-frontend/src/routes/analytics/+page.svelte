<script lang="ts">
import { fetchSeries, type SeriesPoint } from '#lib/api/analytics.ts';
import { getAnalyticsFilters, windowBefore, windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import ModelComparison from '#lib/components/analytics/model-comparison.svelte';
import SpendChart from '#lib/components/analytics/spend-chart.svelte';
import SpendForecast from '#lib/components/analytics/spend-forecast.svelte';
import ChartCard from '#lib/components/app/chart-card.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import StatCard from '#lib/components/app/stat-card.svelte';
import StatGrid from '#lib/components/app/stat-grid.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import {
  headlineComparisons,
  headlineFigures,
  periodComparison,
  unavailableComparisons,
} from '#lib/data/analytics-comparison.ts';
import { type CallerMetric, rankCallers } from '#lib/data/caller-ranking.ts';
import {
  axisTop,
  brokenLinePath,
  FAILED,
  failureRates,
  outcomeBuckets,
  outcomes,
  providerSplit,
  showsTick,
  stackedAreaPaths,
} from '#lib/data/chart-series.ts';
import { fmt, fmtBucket, fmtCostTotal, fmtLatency, fmtMoney, providerTone } from '#lib/data/format.ts';
import { Latest } from '#lib/state/latest.svelte.ts';

// Chart chrome comes from the app's own tokens so the cards match the rest of
// the dashboard.
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const ACCENT = '#10b981';

const AREA_PAD = { top: 14, right: 10, bottom: 24, left: 52 };
const BAR_PAD = { top: 12, right: 8, bottom: 24, left: 76 };

// Keeps touching fills in a stack separable.
const SEGMENT_GAP = 2;

const callerViews = [
  { id: 'requests', label: 'Requests' },
  { id: 'cost_total', label: 'Spend' },
] satisfies { id: CallerMetric; label: string }[];
const tokenSeries = [
  { id: 'input', label: 'Input', color: '#60a5fa' },
  { id: 'output', label: 'Output', color: '#a78bfa' },
];

// The range and model filters come from the analytics layout, shared by every
// tab.
const filters = getAnalyticsFilters();
const range = $derived(filters.range);
const providerFilter = $derived(filters.provider);
const modelFilter = $derived(filters.model);
const comparisonLabel = $derived(`the previous ${range.days === 1 ? '24 hours' : `${range.days} days`}`);

interface Overview {
  totals: SeriesPoint | null;
  byStatus: SeriesPoint[];
  timeline: SeriesPoint[];
  outcomePoints: SeriesPoint[];
  providerPoints: SeriesPoint[];
  modelPoints: SeriesPoint[];
  modelFailures: SeriesPoint[];
  callerPoints: SeriesPoint[];

  /**
   * The equally long window before, or null when it could not be loaded, which
   * leaves the current charts on show.
   */
  previous: {
    totals: SeriesPoint | null;
    statuses: SeriesPoint[];
    modelPoints: SeriesPoint[];
    callerPoints: SeriesPoint[];
  } | null;
}

const overview = new Latest<Overview>({ failureMessage: 'Failed to load analytics.' });

/**
 * Fetches the current range and the equally long window before it.
 */
async function fetchOverview(): Promise<Overview> {
  const selection = { provider: providerFilter || undefined, model: modelFilter || undefined };

  const [[totals, byStatus, timeline, providers, models, callers, modelStatuses, statusTimeline], earlier] =
    await Promise.all([
      fetchSeries({
        ...selection,
        ...windowOf(range.days),
        interval: range.interval,
        groupings: [
          [],
          ['status'],
          ['bucket'],
          ['bucket', 'provider'],
          ['provider', 'model'],
          ['actor'],
          ['provider', 'model', 'status'],
          ['bucket', 'status'],
        ],
      }),

      // Caught here, so that a failed comparison does not hide the current
      // charts.
      fetchSeries({
        ...selection,
        ...windowBefore(range.days),
        groupings: [[], ['status'], ['provider', 'model'], ['actor']],
      }).catch(() => null),
    ]);

  return {
    totals: totals[0] ?? null,
    byStatus: byStatus,
    timeline: timeline,
    outcomePoints: statusTimeline,
    providerPoints: providers,
    modelPoints: models,
    modelFailures: modelStatuses.filter((point) => point.status === 'failed'),
    callerPoints: callers,
    previous: earlier && {
      totals: earlier[0][0] ?? null,
      statuses: earlier[1],
      modelPoints: earlier[2],
      callerPoints: earlier[3],
    },
  };
}

function load(): void {
  void overview.load(fetchOverview);
}

$effect(() => {
  // The fetch also reads the provider and model selections.
  void range.id;
  load();
});

const loading = $derived(overview.loading);
const loadError = $derived(overview.error);
const totals = $derived(overview.value?.totals ?? null);
const byStatus = $derived(overview.value?.byStatus ?? []);
const timeline = $derived(overview.value?.timeline ?? []);
const outcomePoints = $derived(overview.value?.outcomePoints ?? []);
const providerPoints = $derived(overview.value?.providerPoints ?? []);
const modelPoints = $derived(overview.value?.modelPoints ?? []);
const modelFailures = $derived(overview.value?.modelFailures ?? []);
const callerPoints = $derived(overview.value?.callerPoints ?? []);
const previous = $derived(overview.value?.previous ?? null);
const previousModelPoints = $derived(previous?.modelPoints ?? null);
const previousCallerPoints = $derived(previous?.callerPoints ?? null);

// Headline figures

const headline = $derived(headlineFigures(totals, byStatus));
const previousHeadline = $derived(previous?.totals ? headlineFigures(previous.totals, previous.statuses) : null);
const comparisons = $derived.by(() => {
  if (loading || loadError) {
    return undefined;
  }

  if (!previous) {
    return unavailableComparisons(comparisonLabel);
  }

  return headlineComparisons(headline, previousHeadline, comparisonLabel);
});

function bucketLabel(iso: string | null): string {
  return fmtBucket(iso, range.interval);
}

// Spare viewport height is shared across the three desktop rows. The layout is
// measured, so that wrapped headers, browser zoom and banners all count toward
// the budget.
let bodyGrowth = $state(0);
let cardGrid = $state<HTMLDivElement>();
let frame = 0;

function measureCards(): void {
  frame = 0;

  const main = cardGrid?.closest('main');

  if (!cardGrid || !main) {
    return;
  }

  const columns = getComputedStyle(cardGrid).gridTemplateColumns.split(' ').length;

  if (columns !== 2) {
    bodyGrowth = 0;

    return;
  }

  const top = cardGrid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  const available = main.clientHeight - top - parseFloat(getComputedStyle(main).paddingBottom) - 1;
  const rows = Math.ceil(cardGrid.children.length / columns);

  bodyGrowth = Math.max(0, Math.floor(bodyGrowth + (available - cardGrid.getBoundingClientRect().height) / rows));
}

/**
 * Measures on the next frame, however many changes ask for it before then.
 */
function scheduleMeasure(): void {
  if (!frame) {
    frame = requestAnimationFrame(measureCards);
  }
}

$effect(() => {
  const main = cardGrid?.closest('main');

  if (!cardGrid || !main) {
    return;
  }

  const resize = new ResizeObserver(scheduleMeasure);
  const mutations = new MutationObserver(scheduleMeasure);

  resize.observe(main);
  resize.observe(cardGrid);

  for (const sibling of main.children) {
    resize.observe(sibling);
  }

  mutations.observe(main, { childList: true });
  window.addEventListener('resize', scheduleMeasure);
  scheduleMeasure();

  return () => {
    cancelAnimationFrame(frame);
    frame = 0;
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', scheduleMeasure);
  };
});

// Requests, tokens and error rate over time

const AREA_H = $derived(160 + bodyGrowth);

let areaWidth = $state(720);
let areaHover = $state<number | null>(null);
let trafficView = $state<'requests' | 'tokens' | 'errors'>('requests');
const trafficViews = [
  { id: 'requests', label: 'Requests' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'errors', label: 'Error rate' },
] satisfies { id: typeof trafficView; label: string }[];
const trafficTitle = $derived(
  trafficView === 'tokens'
    ? 'Tokens over time'
    : trafficView === 'errors'
      ? 'Error rate over time'
      : 'Requests over time',
);
const trafficHint = $derived(
  trafficView === 'tokens'
    ? 'Input · output tokens'
    : trafficView === 'errors'
      ? 'Failed requests / all requests'
      : 'Success · incomplete · failed',
);

const outcomeCounts = $derived(outcomeBuckets(timeline, outcomePoints));
const bucketErrorRates = $derived(failureRates(timeline, outcomeCounts));
const trafficSeries = $derived(trafficView === 'tokens' ? tokenSeries : outcomes);
const trafficCounts = $derived(
  trafficView === 'tokens' ? timeline.map((point) => [point.input_tokens, point.output_tokens]) : outcomeCounts,
);
const trafficMax = $derived.by(() => {
  if (trafficView === 'errors') {
    return Math.min(100, axisTop(Math.max(1, ...bucketErrorRates.map((rate) => rate ?? 0))));
  }

  const peaks = timeline.map((point) =>
    trafficView === 'tokens' ? point.input_tokens + point.output_tokens : point.requests,
  );

  return axisTop(Math.max(1, ...peaks));
});
const areaInnerW = $derived(Math.max(1, areaWidth - AREA_PAD.left - AREA_PAD.right));
const areaInnerH = $derived(AREA_H - AREA_PAD.top - AREA_PAD.bottom);

function areaX(index: number): number {
  return AREA_PAD.left + (index / Math.max(1, timeline.length - 1)) * areaInnerW;
}

function areaY(value: number): number {
  return AREA_PAD.top + areaInnerH - (value / trafficMax) * areaInnerH;
}

const outcomeAreas = $derived.by(() => {
  const paths = stackedAreaPaths(trafficCounts, areaX, areaY);

  return trafficSeries.map((series, index) => ({ ...series, path: paths[index] }));
});
const errorRatePath = $derived(brokenLinePath(bucketErrorRates, areaX, areaY));

$effect(() => {
  void timeline;
  void trafficView;
  areaHover = null;
});

function onAreaMove(event: MouseEvent): void {
  if (timeline.length === 0) {
    return;
  }

  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - AREA_PAD.left) / areaInnerW;
  areaHover = Math.max(0, Math.min(timeline.length - 1, Math.round(ratio * (timeline.length - 1))));
}

// Provider split, as stacked bars

const BAR_H = $derived(160 + bodyGrowth);

let barWidth = $state(360);
let barHover = $state<number | null>(null);
let providerView = $state<'volume' | 'share'>('volume');
let providerMetric = $state<CallerMetric>('requests');
const providerViews = $derived([
  { id: 'volume' as const, label: providerMetric === 'requests' ? 'Volume' : 'Amount' },
  { id: 'share' as const, label: 'Share' },
]);
const providerTitle = $derived(providerMetric === 'requests' ? 'Requests by provider' : 'Spend by provider');

const split = $derived(providerSplit(providerPoints, providerMetric));
const providerSeries = $derived(split.providers.map((id) => ({ id: id, ...providerTone(id) })));
const providerMax = $derived(providerView === 'share' ? 100 : axisTop(Math.max(0, ...split.totals)));
const barInnerW = $derived(Math.max(1, barWidth - BAR_PAD.left - BAR_PAD.right));
const barInnerH = $derived(BAR_H - BAR_PAD.top - BAR_PAD.bottom);
const barSlot = $derived(barInnerW / Math.max(1, split.buckets.length));
const barThickness = $derived(Math.min(28, barSlot * 0.62));

// Segment rectangles per bucket, stacked from the baseline up.
const stacks = $derived(
  split.values.map((row, bucketIndex) => {
    const total = split.totals[bucketIndex] ?? 0;
    const gap = providerView === 'share' ? 0 : SEGMENT_GAP;
    let cursor = 0;

    return providerSeries.map((series, index) => {
      const value = row[index] ?? 0;
      const share = total > 0 ? (value / total) * 100 : 0;
      const height = ((providerView === 'share' ? share : value) / providerMax) * barInnerH;
      const y = BAR_PAD.top + barInnerH - cursor - height;
      cursor += height;

      return { series: series, value: value, share: share, y: y, height: Math.max(0, height - gap) };
    });
  }),
);

$effect(() => {
  void providerPoints;
  void providerView;
  void providerMetric;
  barHover = null;
});

// Top callers

let callerMetric = $state<CallerMetric>('requests');
const topCallers = $derived(rankCallers(callerPoints, callerMetric, previousCallerPoints ?? []));
const callerComparisonUnavailable = $derived(loadError !== null || previousCallerPoints === null);

function callerAmount(value: number): string {
  return callerMetric === 'requests' ? value.toLocaleString() : fmtMoney(value);
}
</script>


{#if loadError}
	<div class="mb-3.5 flex items-center gap-[9px] rounded-lg border border-red-500/20 bg-red-500/7 px-[13px] py-2.5">
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="flex-none"><circle cx="8" cy="8" r="6.3" stroke="#ef4444" stroke-width="1.4" /><path d="M8 4.8v3.6M8 11v.01" stroke="#ef4444" stroke-width="1.4" stroke-linecap="round" /></svg>
		<span class="text-[12.5px] text-[#e0a0a0]">{loadError}</span>
	</div>
{/if}

<StatGrid compact columns={6}>
	<StatCard compact label="Requests" value={loading ? '—' : fmt(headline.requests)} comparison={comparisons?.requests} />
	<StatCard
		compact
		label="Tokens used"
		value={loading ? '—' : fmt(headline.tokens)}
		comparison={comparisons?.tokens}
	/>
	<StatCard compact label="Spend" value={loading ? '—' : fmtCostTotal(headline.spend)} comparison={comparisons?.spend} />
    <StatCard
        compact
        label="Avg $/request"
        value={loading || loadError || headline.averageCost === null ? '—' : fmtMoney(headline.averageCost, 4)}
        comparison={comparisons?.averageCost}
    />
	<StatCard
        compact
		label="Median latency"
		comparison={comparisons?.latency}
		value={loading ? '—' : fmtLatency(headline.latency)}
		hint={loading || totals?.p95_latency_ms == null ? undefined : `p95 ${fmtLatency(totals.p95_latency_ms)}`}
	/>
	<StatCard
        compact
		label="Error rate"
		comparison={comparisons?.errorRate}
		value={loading ? '—' : `${(headline.errorRate ?? 0).toFixed(2)}%`}
		hint={loading ? undefined : `${(headline.inFlightRate ?? 0).toFixed(2)}% in flight`}
	/>
</StatGrid>

<!-- One grid keeps all six cards equally tall, even when toolbars wrap or tabs change. -->
<div bind:this={cardGrid} style:--analytics-body-growth={`${bodyGrowth}px`} class="grid grid-cols-1 items-stretch gap-[var(--analytics-gap)] lg:auto-rows-fr lg:grid-cols-2 [&>*]:min-w-0">
	<ChartCard title={trafficTitle} hint={trafficHint}>
        {#snippet actions()}<FilterTabs tabs={trafficViews} bind:value={trafficView} />{/snippet}
        <div class="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-zinc-500">
            {#if trafficView === 'errors'}
                <span class="flex items-center gap-1.5"><span class="size-[7px] rounded-full bg-red-500"></span>Failed / all requests</span>
            {:else}
                {#each trafficSeries as series (series.id)}
                    <span class="flex items-center gap-1.5"><span class="size-[7px] rounded-full" style:background={series.color}></span>{series.label}</span>
                {/each}
            {/if}
        </div>
		<div class="relative" bind:clientWidth={areaWidth}>
			{#if loading}
                <div class="flex h-[calc(160px+var(--analytics-body-growth,0px))] items-center justify-center text-[12.5px] text-zinc-600">Loading {trafficView === 'tokens' ? 'tokens' : trafficView === 'errors' ? 'error rate' : 'requests'}…</div>
            {:else if timeline.length === 0}
				<div class="flex h-[calc(160px+var(--analytics-body-growth,0px))] items-center justify-center text-[12.5px] text-zinc-600">
					No requests in this window.
				</div>
			{:else}
				<svg
					width={areaWidth}
					height={AREA_H}
					role="img"
					aria-label="{trafficTitle} · {range.label.toLowerCase()}"
					onmousemove={onAreaMove}
					onmouseleave={() => (areaHover = null)}
				>

					{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
						{@const y = AREA_PAD.top + areaInnerH * tick}
						<line x1={AREA_PAD.left} y1={y} x2={areaWidth - AREA_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={AREA_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{trafficView === 'errors' ? `${Number((trafficMax * (1 - tick)).toFixed(2))}%` : fmt(Math.round(trafficMax * (1 - tick)))}
						</text>
					{/each}

                        {#if trafficView === 'errors'}
                            <path d={errorRatePath} fill="none" stroke="#ef4444" stroke-width="2" />
                            {#each bucketErrorRates as rate, index (index)}
                                {#if rate !== null}<circle cx={areaX(index)} cy={areaY(rate)} r="3" fill="#ef4444" />{/if}
                            {/each}
                        {:else}
                        {#each outcomeAreas as series, index (series.id)}
                            {#if timeline.length === 1}
                                {@const upper = trafficCounts[0]!.slice(0, index + 1).reduce((a, b) => a + b, 0)}
                                <rect x={AREA_PAD.left} y={areaY(upper)} width={Math.min(32, areaInnerW)} height={trafficCounts[0]![index]! / trafficMax * areaInnerH} fill={series.color} />
                            {:else}
                                <path d={series.path} fill={series.color} fill-opacity="0.65" stroke={series.color} stroke-width="1" />
                            {/if}
                        {/each}
                        {/if}

					{#each timeline as point, i (point.bucket)}
						{#if showsTick(i, Math.max(1, Math.ceil(timeline.length / Math.max(2, Math.floor(areaInnerW / 75)))), timeline.length)}
							<text x={areaX(i)} y={AREA_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
								{bucketLabel(point.bucket)}
							</text>
						{/if}
					{/each}

					{#if areaHover !== null && timeline[areaHover]}
						{@const point = timeline[areaHover]!}
						<line
							x1={areaX(areaHover)}
							y1={AREA_PAD.top}
							x2={areaX(areaHover)}
							y2={AREA_PAD.top + areaInnerH}
							stroke="#3f3f46"
							stroke-width="1"
						/>
					{/if}
				</svg>

				{#if areaHover !== null && timeline[areaHover]}
					{@const point = timeline[areaHover]!}
					<div
						class="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
						style:left="{Math.min(Math.max(areaX(areaHover), 78), areaWidth - 78)}px"
					>
						<div class="mb-1 text-[10.5px] text-zinc-500">{bucketLabel(point.bucket)}</div>
						<div class="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-zinc-200">
							<span class="size-[7px] rounded-full" style:background={trafficView === 'errors' ? '#ef4444' : trafficView === 'tokens' ? '#60a5fa' : ACCENT}></span>
							<span class="tabular-nums">{trafficView === 'errors' ? bucketErrorRates[areaHover] == null ? '—' : `${bucketErrorRates[areaHover]!.toFixed(2)}%` : (trafficView === 'tokens' ? point.input_tokens + point.output_tokens : point.requests).toLocaleString()}</span>
							<span class="text-zinc-600">{trafficView === 'errors' ? 'error rate' : trafficView === 'tokens' ? 'tokens' : 'requests'}</span>
						</div>

                        {#if trafficView === 'errors'}
                            <div class="mt-1 text-[11.5px] text-zinc-300 tabular-nums">{(outcomeCounts[areaHover]?.[FAILED] ?? 0).toLocaleString()} failed / {point.requests.toLocaleString()} requests</div>
                            {#if point.requests === 0}<div class="mt-1 text-[11.5px] text-zinc-500">No requests in this bucket.</div>{/if}
                        {:else}
                            {#each trafficSeries as series, index (series.id)}
                                <div class="mt-1 flex justify-between gap-4 text-[11.5px]" style:color={series.color}><span>{series.label}</span><span class="tabular-nums">{trafficCounts[areaHover]?.[index]?.toLocaleString() ?? '0'}</span></div>
                            {/each}
                        {/if}
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>
	<SpendChart
        height={AREA_H}
        interval={range.interval}
        points={timeline}
        {loading}
        rangeLabel={range.label}
        {bucketLabel}
        {modelPoints}
        {previousModelPoints}
        {comparisonLabel}
        comparisonUnavailable={loadError !== null || previousModelPoints === null}
        onretry={load}
    />

	<!-- provider split -->
	<ChartCard title={providerTitle} hint={providerView === 'share' ? `Percentage of ${providerMetric === 'requests' ? 'requests' : 'spend'} per bucket.` : 'Stacked per bucket.'}>
        {#snippet actions()}
            <FilterTabs tabs={callerViews} bind:value={providerMetric} />
            <FilterTabs tabs={providerViews} bind:value={providerView} />
        {/snippet}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				{#each providerSeries as series (series.id)}
					<span class="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
						<span class="size-[7px] flex-none rounded-full" style:background={series.color}></span>
						{series.label}
					</span>
				{/each}
			</div>

		<div class="relative" bind:clientWidth={barWidth}>
			{#if loading}
                <div class="flex h-[calc(160px+var(--analytics-body-growth,0px))] items-center justify-center text-[12.5px] text-zinc-600">Loading providers…</div>
            {:else if split.buckets.length === 0}
				<div class="flex h-[calc(160px+var(--analytics-body-growth,0px))] items-center justify-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{:else}
				<svg width={barWidth} height={BAR_H} role="img" aria-label="{providerTitle} over {range.label.toLowerCase()} · {providerView === 'share' ? 'share' : 'amount'}">
					{#each [0, 0.5, 1] as tick (tick)}
						{@const y = BAR_PAD.top + barInnerH * tick}
						<line x1={BAR_PAD.left} y1={y} x2={barWidth - BAR_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={BAR_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{providerView === 'share' ? `${Math.round(providerMax * (1 - tick))}%` : providerMetric === 'cost_total' ? fmtMoney(providerMax * (1 - tick)) : fmt(Math.round(providerMax * (1 - tick)))}
						</text>
					{/each}

					{#each stacks as stack, bucketIndex (split.buckets[bucketIndex])}
						{@const cx = BAR_PAD.left + barSlot * (bucketIndex + 0.5)}
						<!-- Hit target spans the whole slot, not just the bar -->
						<rect
							x={cx - barSlot / 2}
							y={BAR_PAD.top}
							width={barSlot}
							height={barInnerH}
							fill="transparent"
							role="presentation"
							onmouseenter={() => (barHover = bucketIndex)}
							onmouseleave={() => (barHover = null)}
						/>
						{#each stack as segment (segment.series.id)}
							<rect
								x={cx - barThickness / 2}
								y={segment.y}
								width={barThickness}
								height={segment.height}
								rx={providerView === 'share' ? 0 : 2}
                                pointer-events="none"
								fill={segment.series.color}
								opacity={barHover === null || barHover === bucketIndex ? 1 : 0.35}
							/>
						{/each}
						{#if showsTick(bucketIndex, Math.max(1, Math.ceil(split.buckets.length / 6)), split.buckets.length)}
							<text x={cx} y={BAR_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
								{bucketLabel(split.buckets[bucketIndex] ?? null)}
							</text>
						{/if}
					{/each}
				</svg>

				{#if barHover !== null && stacks[barHover]}
					{@const cx = BAR_PAD.left + barSlot * (barHover + 0.5)}
					<div
						class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
						style:left="{Math.min(Math.max(cx, 86), barWidth - 86)}px"
					>
						<div class="mb-1 text-[10.5px] text-zinc-500">{bucketLabel(split.buckets[barHover] ?? null)}</div>
						{#each stacks[barHover]! as segment (segment.series.id)}
							<div class="flex items-center gap-2 text-[11.5px] whitespace-nowrap">
								<span class="size-[7px] flex-none rounded-full" style:background={segment.series.color}></span>
								<span class="flex-1 text-zinc-500">{segment.series.label}</span>
								<span class="text-zinc-200 tabular-nums">{providerMetric === 'cost_total' ? fmtMoney(segment.value) : segment.value.toLocaleString()} <span class="text-zinc-500">· {(split.totals[barHover] ?? 0) > 0 ? `${segment.share.toFixed(1)}%` : '—'}</span></span>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>

	<!-- this month's spend and forecast -->
	<SpendForecast provider={providerFilter} model={modelFilter} height={AREA_H} />

	<ModelComparison
        points={modelPoints}
        failures={modelFailures}
        previousPoints={previousModelPoints}
        {comparisonLabel}
        comparisonUnavailable={loadError !== null || previousModelPoints === null}
        onretry={load}
        {loading}
        onselect={(provider, model) => {
          filters.provider = provider;
          filters.model = model;
        }}
    />

	<!-- top callers -->
	<ChartCard title="Top callers" hint={`Current top callers vs ${comparisonLabel}`}>
        {#snippet actions()}
            <FilterTabs tabs={callerViews} bind:value={callerMetric} />
        {/snippet}
		<div class="flex min-h-[calc(176px+var(--analytics-body-growth,0px))] flex-col justify-between gap-1">
			{#if loading}
                <div class="py-8 text-center text-[12.5px] text-zinc-600">Loading callers…</div>
            {:else}
            {#if callerComparisonUnavailable}
                <div class="flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500" role="status">
                    <span>Previous-period comparison unavailable.</span>
                    <ToolbarButton onclick={load}>Retry comparison</ToolbarButton>
                </div>
            {/if}
            {#each topCallers as caller (`${caller.actor_type}-${caller.actor_id}`)}
                {@const delta = caller.value - caller.previous}
                {@const comparison = periodComparison(caller.value, caller.previous, { label: comparisonLabel, lowerIsBetter: callerMetric === 'cost_total' })}
				<!-- Opens the users behind this caller on the Users tab. -->
				<a
					href="/analytics/users?actor={caller.actor_id}"
					title="See the users behind {caller.actor_label ?? 'this caller'}"
					class="grid grid-cols-[minmax(80px,1.1fr)_minmax(0,1fr)_64px_100px] items-center gap-3 rounded-[4px] hover:bg-surface-6"
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<!-- The kind of credential is not decoration. A key and a human are
						     different things to hold accountable for the same spend. -->
						<span
							class="w-14 flex-none rounded-[3px] px-1 py-[1px] text-center text-[9.5px] tracking-wide uppercase {caller.actor_type ===
							'api_key'
								? 'bg-sky-500/12 text-sky-300/80'
								: 'bg-violet-500/12 text-violet-300/80'}"
						>
							{caller.actor_type === 'api_key' ? 'key' : caller.actor_type === 'user' ? 'user' : caller.actor_type === 'system' ? 'system' : 'unknown'}
						</span>
						<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-300">
							{caller.actor_label ?? 'Unknown actor'}
						</span>
					</span>
					<div class="h-[18px] w-full">
						<div
							class="h-full rounded-r-[4px]"
							style:width={`${caller.width}%`}
							style:background={callerMetric === 'requests' ? ACCENT : '#a78bfa'}
							style:opacity={0.35 + 0.65 * caller.width / 100}
						></div>
					</div>
					<span class="text-right text-[12.5px] text-zinc-300 tabular-nums" title={callerMetric === 'requests' ? `${caller.requests.toLocaleString()} requests` : `$${caller.cost_total.toLocaleString('en-US', { maximumFractionDigits: 6 })} spend`}>{callerMetric === 'requests' ? fmt(caller.requests) : fmtCostTotal(caller.cost_total)}</span>
                        <span class="text-right text-[12px] leading-[13px] text-zinc-400 tabular-nums" title={callerComparisonUnavailable ? 'Comparison unavailable' : `Previous: ${callerAmount(caller.previous)}. Current: ${callerAmount(caller.value)}. ${comparison.title}`}>
                            {#if callerComparisonUnavailable}—{:else}
                                <span class="block whitespace-nowrap text-zinc-200">{delta > 0 ? '+' : delta < 0 ? '−' : ''}{callerAmount(Math.abs(delta))}</span>
                                <span class="block whitespace-nowrap text-[11px] font-medium" style:color={comparison.color}>{comparison.text}</span>
                            {/if}
                        </span>
				</a>
			{:else}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{/each}
            {/if}
		</div>
	</ChartCard>
</div>
