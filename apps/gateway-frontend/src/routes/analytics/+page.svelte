<script lang="ts">
import { fetchSeries, type SeriesPoint } from '$lib/api/analytics';
import { alignedNow, getAnalyticsFilters } from '$lib/components/analytics/analytics-filters.svelte';
import ModelComparison from '$lib/components/analytics/model-comparison.svelte';
import SpendChart from '$lib/components/analytics/spend-chart.svelte';
import SpendForecast from '$lib/components/analytics/spend-forecast.svelte';
import ChartCard from '$lib/components/app/chart-card.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { periodComparison } from '$lib/data/analytics-comparison';
import { type CallerMetric, rankCallers } from '$lib/data/caller-ranking';
import { outcomeBuckets, outcomes } from '$lib/data/chart-series';
import { fmt, fmtBucket, fmtCostTotal, fmtLatency } from '$lib/data/format';

/**
 * Categorical hues for providers, validated against this surface (#0a0a0c) for
 * lightness band, chroma, CVD separation and contrast.
 *
 * Keyed by provider NAME, not by position in the data. Assigning by rank would
 * repaint every surviving series the moment a filter drops one, which is
 * exactly the thing that makes a stacked chart unreadable across two loads.
 * A provider with no entry here reads as "Other" rather than borrowing a hue
 * that already means something else.
 */
const PROVIDER_COLORS: Record<string, string> = {
  openai: '#059669',
  azure: '#0284c7',
  anthropic: '#d97706',
  google: '#3b82f6',
  mistral: '#ea580c',
  bedrock: '#a855f7',
};
const OTHER_INK = '#52525b';
const providerColor = (id: string) => PROVIDER_COLORS[id] ?? OTHER_INK;

// Chart ink. Chrome comes from the app's own tokens so the cards match the rest
// of the dashboard; only the DATA colours come from the validated palette.
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const ACCENT = '#10b981';

// The range and model filters come from the analytics layout, shared by every tab.
const filters = getAnalyticsFilters();
const range = $derived(filters.range);
const providerFilter = $derived(filters.provider);
const modelFilter = $derived(filters.model);

let loading = $state(true);
let loadError = $state<string | null>(null);

let totals = $state<SeriesPoint | null>(null);
let byStatus: SeriesPoint[] = $state([]);
let timeline: SeriesPoint[] = $state([]);
let outcomePoints = $state<SeriesPoint[]>([]);
const outcomeCounts = $derived(outcomeBuckets(timeline, outcomePoints));
let providerPoints: SeriesPoint[] = $state([]);
let modelPoints: SeriesPoint[] = $state([]);
let modelFailures: SeriesPoint[] = $state([]);
let previousModelPoints = $state<SeriesPoint[] | null>(null);
let callerPoints: SeriesPoint[] = $state([]);
let previousCallerPoints = $state<SeriesPoint[] | null>(null);
let callerMetric = $state<CallerMetric>('requests');
const callerViews = [
  { id: 'requests', label: 'Requests' },
  { id: 'cost_total', label: 'Spend' },
] satisfies { id: CallerMetric; label: string }[];
const topCallers = $derived(rankCallers(callerPoints, callerMetric));
const comparisonLabel = $derived(`the previous ${range.days === 1 ? '24 hours' : `${range.days} days`}`);
const previousCallerValues = $derived(
  new Map(
    (previousCallerPoints ?? []).map((point) => [
      JSON.stringify([point.actor_type, point.actor_id]),
      point[callerMetric],
    ]),
  ),
);
const callerComparisonUnavailable = $derived(loadError !== null || previousCallerPoints === null);
const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2,
  }).format(value);
const callerAmount = (value: number) => (callerMetric === 'requests' ? value.toLocaleString() : money(value));
let previousTotals = $state<SeriesPoint | null>(null);
let previousStatuses = $state<SeriesPoint[]>([]);
let comparisonError = $state(false);
let loadRequest = 0;

/** Load the current range and an adjacent, equally long comparison window. */
async function load() {
  const request = ++loadRequest;
  loading = true;
  loadError = null;
  comparisonError = false;
  previousTotals = null;
  previousStatuses = [];
  previousModelPoints = null;
  previousCallerPoints = null;

  const end = alignedNow();
  const duration = range.days * 86_400_000;
  const start = new Date(end - duration).toISOString();
  const filters = { provider: providerFilter || undefined, model: modelFilter || undefined };
  const common = { ...filters, start_date: start, end_date: new Date(end).toISOString() };
  // The previous window ends on a 5-minute mark, so its query only changes every
  // 5 minutes and the server's cache can answer it until then (its data no
  // longer changes). It sits at most 5 minutes before the current one.
  const previousEnd = Math.floor((end - duration) / 300_000) * 300_000;
  const previous = {
    ...filters,
    start_date: new Date(previousEnd - duration).toISOString(),
    end_date: new Date(previousEnd).toISOString(),
  };

  try {
    const [
      [totalsPoints, statusPoints, series, providers, models, callers, modelStatuses, statusTimeline],
      [comparison],
    ] = await Promise.all([
      fetchSeries({
        ...common,
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
      // A failed comparison must not hide the current charts.
      Promise.allSettled([fetchSeries({ ...previous, groupings: [[], ['status'], ['provider', 'model'], ['actor']] })]),
    ]);
    if (request !== loadRequest) return;
    totals = totalsPoints[0] ?? null;
    byStatus = statusPoints;
    timeline = series;
    outcomePoints = statusTimeline;
    providerPoints = providers;
    modelPoints = models;
    // Failures per model, from the model and status grouping.
    modelFailures = modelStatuses.filter((point) => point.status === 'failed');
    callerPoints = callers;
    if (comparison.status === 'fulfilled') {
      const [previousTotalPoints, previousStatusPoints, previousModels, previousCallers] = comparison.value;
      previousTotals = previousTotalPoints[0] ?? null;
      previousStatuses = previousStatusPoints;
      previousModelPoints = previousModels;
      previousCallerPoints = previousCallers;
    } else {
      comparisonError = true;
    }
  } catch (error) {
    if (request !== loadRequest) return;
    loadError = error instanceof Error ? error.message : 'Failed to load analytics.';
  } finally {
    if (request === loadRequest) loading = false;
  }
}

$effect(() => {
  // load() also tracks the provider and model selections.
  void range.id;
  void load();
});

// ---- headline figures ---------------------------------------------------------
const statusCount = (name: string) => byStatus.find((p) => p.status === name)?.requests ?? 0;

const requestTotal = $derived(totals?.requests ?? 0);
const failed = $derived(statusCount('failed'));
const inFlight = $derived(statusCount('incomplete'));

/**
 * Failed over total - NOT "everything that is not complete".
 *
 * A row is written before the provider is called and updated after it, so the
 * in-flight ones are requests that have not finished rather than requests that
 * went wrong. Folding them in inflates the rate exactly when concurrency is
 * highest, which is when somebody is reading it during an incident.
 */
const errorRate = $derived(requestTotal > 0 ? (failed / requestTotal) * 100 : 0);
const inFlightRate = $derived(requestTotal > 0 ? (inFlight / requestTotal) * 100 : 0);
const averageCostPerRequest = $derived(totals && totals.requests > 0 ? totals.cost_total / totals.requests : null);
const formatAverageCost = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 4,
  }).format(value);

const comparisons = $derived.by(() => {
  if (loading || loadError) return undefined;
  const label = `the previous ${range.days === 1 ? '24 hours' : `${range.days} days`}`;
  if (comparisonError) {
    const unavailable = { text: 'Unavailable', color: '#a1a1aa', title: `Could not load ${label}.` };
    return {
      requests: unavailable,
      tokens: unavailable,
      spend: unavailable,
      averageCost: unavailable,
      latency: unavailable,
      errors: unavailable,
    };
  }
  const previousRequests = previousTotals?.requests ?? null;
  const previousFailed = previousStatuses.find((point) => point.status === 'failed')?.requests ?? 0;
  const previousErrorRate = previousRequests ? (previousFailed / previousRequests) * 100 : null;
  return {
    requests: periodComparison(requestTotal, previousRequests, { label }),
    tokens: periodComparison(totals?.total_tokens ?? 0, previousTotals?.total_tokens ?? null, { label }),
    spend: periodComparison(totals?.cost_total ?? 0, previousTotals?.cost_total ?? null, {
      label,
      lowerIsBetter: true,
    }),
    averageCost: periodComparison(
      averageCostPerRequest,
      previousTotals && previousTotals.requests > 0 ? previousTotals.cost_total / previousTotals.requests : null,
      { label, lowerIsBetter: true },
    ),
    latency: periodComparison(totals?.median_latency_ms ?? null, previousTotals?.median_latency_ms ?? null, {
      label,
      lowerIsBetter: true,
    }),
    errors: periodComparison(requestTotal > 0 ? errorRate : null, previousErrorRate, {
      label,
      lowerIsBetter: true,
    }),
  };
});

function bucketLabel(iso: string | null): string {
  return fmtBucket(iso, range.interval);
}

/**
 * Whether to draw an x-axis label at this index.
 *
 * Every `every`th tick, plus the last one - but a regular tick is suppressed
 * when the last one would land on top of it.
 */
const showTick = (i: number, every: number, total: number) =>
  i === total - 1 || (i % every === 0 && total - 1 - i >= every - 1);

/** Rounds a max up to a friendly axis top so gridlines land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
}

// Share spare viewport height across the three desktop rows. Measure the actual
// layout so wrapped headers, browser zoom and banners all count toward the budget.
let bodyGrowth = $state(0);
function fitCards(grid: HTMLDivElement) {
  const main = grid.closest('main');
  if (!main) return;
  let frame = 0;
  const measure = () => {
    frame = 0;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    if (columns !== 2) {
      bodyGrowth = 0;
      return;
    }
    const top = grid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    const available = main.clientHeight - top - parseFloat(getComputedStyle(main).paddingBottom) - 1;
    const rows = Math.ceil(grid.children.length / columns);
    bodyGrowth = Math.max(0, Math.floor(bodyGrowth + (available - grid.getBoundingClientRect().height) / rows));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(main);
  resize.observe(grid);
  for (const sibling of main.children) resize.observe(sibling);
  const mutations = new MutationObserver(schedule);
  mutations.observe(main, { childList: true });
  window.addEventListener('resize', schedule);
  schedule();
  return {
    destroy() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
    },
  };
}

// ---- requests, tokens and error rate over time -------------------------------
const AREA_H = $derived(160 + bodyGrowth);
const AREA_PAD = { top: 14, right: 10, bottom: 24, left: 52 };

let areaWidth = $state(720);
let areaHover = $state<number | null>(null);
let trafficView = $state<'requests' | 'tokens' | 'errors'>('requests');
const trafficViews = [
  { id: 'requests', label: 'Requests' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'errors', label: 'Error rate' },
] satisfies { id: typeof trafficView; label: string }[];
const tokenSeries = [
  { id: 'input', label: 'Input', color: '#60a5fa' },
  { id: 'output', label: 'Output', color: '#a78bfa' },
];
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
const trafficSeries = $derived(trafficView === 'tokens' ? tokenSeries : outcomes);
const trafficCounts = $derived(
  trafficView === 'tokens' ? timeline.map((point) => [point.input_tokens, point.output_tokens]) : outcomeCounts,
);
const failedOutcomeIndex = outcomes.findIndex((outcome) => outcome.id === 'failed');
// Incomplete requests remain in the denominator, matching the headline rate.
// A bucket with no requests has no rate, rather than a misleading 0%.
const bucketErrorRates = $derived(
  timeline.map((point, index) =>
    point.requests > 0 ? ((outcomeCounts[index]?.[failedOutcomeIndex] ?? 0) / point.requests) * 100 : null,
  ),
);

const trafficMax = $derived(
  trafficView === 'errors'
    ? Math.min(100, niceMax(Math.max(1, ...bucketErrorRates.map((rate) => rate ?? 0))))
    : niceMax(
        Math.max(
          1,
          ...timeline.map((point) =>
            trafficView === 'tokens' ? point.input_tokens + point.output_tokens : point.requests,
          ),
        ),
      ),
);
const areaInnerW = $derived(Math.max(1, areaWidth - AREA_PAD.left - AREA_PAD.right));
const areaInnerH = $derived(AREA_H - AREA_PAD.top - AREA_PAD.bottom);

const areaX = (i: number) => AREA_PAD.left + (i / Math.max(1, timeline.length - 1)) * areaInnerW;
const areaY = (v: number) => AREA_PAD.top + areaInnerH - (v / trafficMax) * areaInnerH;

const outcomeAreas = $derived(
  trafficSeries.map((outcome, index) => {
    const upper = timeline.map(
      (_, i) =>
        `${i === 0 ? 'M' : 'L'}${areaX(i)},${areaY((trafficCounts[i] ?? []).slice(0, index + 1).reduce((a, b) => a + b, 0))}`,
    );
    const lower = timeline
      .map((_, i) => `L${areaX(i)},${areaY((trafficCounts[i] ?? []).slice(0, index).reduce((a, b) => a + b, 0))}`)
      .reverse();
    return { ...outcome, path: [...upper, ...lower, 'Z'].join(' ') };
  }),
);
const errorRatePath = $derived.by(() => {
  let connected = false;
  return bucketErrorRates
    .map((rate, index) => {
      if (rate === null) {
        connected = false;
        return '';
      }
      const command = connected ? 'L' : 'M';
      connected = true;
      return `${command}${areaX(index)},${areaY(rate)}`;
    })
    .join(' ');
});
$effect(() => {
  void timeline;
  void trafficView;
  areaHover = null;
});

function onAreaMove(event: MouseEvent) {
  if (timeline.length === 0) return;
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - AREA_PAD.left) / areaInnerW;
  areaHover = Math.max(0, Math.min(timeline.length - 1, Math.round(ratio * (timeline.length - 1))));
}

// ---- provider split (stacked bars, categorical) -------------------------------
const BAR_H = $derived(160 + bodyGrowth);
const BAR_PAD = { top: 12, right: 8, bottom: 24, left: 76 };
/** A 2px gap between stacked segments so touching fills stay separable. */
const SEGMENT_GAP = 2;

let barWidth = $state(360);
let barHover = $state<number | null>(null);
let providerView = $state<'volume' | 'share'>('volume');
let providerMetric = $state<CallerMetric>('requests');
const providerViews = $derived([
  { id: 'volume' as const, label: providerMetric === 'requests' ? 'Volume' : 'Amount' },
  { id: 'share' as const, label: 'Share' },
]);
const providerTitle = $derived(providerMetric === 'requests' ? 'Requests by provider' : 'Spend by provider');

/** Buckets on the x axis, in time order. */
const providerBuckets = $derived([...new Set(providerPoints.map((p) => p.bucket ?? ''))].sort());

/**
 * Providers present in the window, ordered by total volume.
 *
 * The ORDER decides stacking, not colour - each provider's hue is fixed by name
 * in provider-colors.ts, so this can be re-sorted freely without any series changing colour.
 */
const providerSeries = $derived.by(() => {
  const totalsByProvider = new Map<string, number>();
  for (const point of providerPoints) {
    const id = point.provider ?? 'unknown';
    totalsByProvider.set(id, (totalsByProvider.get(id) ?? 0) + point.requests);
  }

  return [...totalsByProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, label: id, color: providerColor(id) }));
});

const providerLookup = $derived.by(() => {
  const table = new Map<string, number>();
  for (const point of providerPoints) {
    table.set(`${point.bucket ?? ''}|${point.provider ?? 'unknown'}`, point[providerMetric]);
  }
  return table;
});

const providerTotals = $derived(
  providerBuckets.map((bucket) =>
    providerSeries.reduce((sum, series) => sum + (providerLookup.get(`${bucket}|${series.id}`) ?? 0), 0),
  ),
);
const providerMax = $derived(providerView === 'share' ? 100 : niceMax(Math.max(0, ...providerTotals)));
const barInnerW = $derived(Math.max(1, barWidth - BAR_PAD.left - BAR_PAD.right));
const barInnerH = $derived(BAR_H - BAR_PAD.top - BAR_PAD.bottom);
const barSlot = $derived(barInnerW / Math.max(1, providerBuckets.length));
const barThickness = $derived(Math.min(28, barSlot * 0.62));

/** Segment rectangles per bucket, stacked from the baseline up. */
const stacks = $derived(
  providerBuckets.map((bucket, bucketIndex) => {
    let cursor = 0;
    return providerSeries.map((series) => {
      const value = providerLookup.get(`${bucket}|${series.id}`) ?? 0;
      const share = (providerTotals[bucketIndex] ?? 0) > 0 ? (value / (providerTotals[bucketIndex] ?? 0)) * 100 : 0;
      const height = ((providerView === 'share' ? share : value) / providerMax) * barInnerH;
      const y = BAR_PAD.top + barInnerH - cursor - height;
      cursor += height;
      return { series, value, share, y, height: Math.max(0, height - (providerView === 'share' ? 0 : SEGMENT_GAP)) };
    });
  }),
);

$effect(() => {
  void providerPoints;
  void providerView;
  void providerMetric;
  barHover = null;
});

// ---- ranked lists (single hue - length already encodes the value) -------------
</script>


{#if loadError}
	<div class="mb-3.5 flex items-center gap-[9px] rounded-lg border border-red-500/20 bg-red-500/7 px-[13px] py-2.5">
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="flex-none"><circle cx="8" cy="8" r="6.3" stroke="#ef4444" stroke-width="1.4" /><path d="M8 4.8v3.6M8 11v.01" stroke="#ef4444" stroke-width="1.4" stroke-linecap="round" /></svg>
		<span class="text-[12.5px] text-[#e0a0a0]">{loadError}</span>
	</div>
{/if}

<StatGrid compact columns={6}>
	<StatCard compact label="Requests" value={loading ? '—' : fmt(requestTotal)} comparison={comparisons?.requests} />
	<StatCard
		compact
		label="Tokens used"
		value={loading ? '—' : fmt(totals?.total_tokens ?? 0)}
		comparison={comparisons?.tokens}
	/>
	<StatCard compact label="Spend" value={loading ? '—' : fmtCostTotal(totals?.cost_total ?? 0)} comparison={comparisons?.spend} />
    <StatCard
        compact
        label="Avg $/request"
        value={loading || loadError || averageCostPerRequest === null ? '—' : formatAverageCost(averageCostPerRequest)}
        comparison={comparisons?.averageCost}
    />
	<StatCard
        compact
		label="Median latency"
		comparison={comparisons?.latency}
		value={loading ? '—' : fmtLatency(totals?.median_latency_ms ?? null)}
		hint={loading || totals?.p95_latency_ms == null ? undefined : `p95 ${fmtLatency(totals.p95_latency_ms)}`}
	/>
	<StatCard
        compact
		label="Error rate"
		comparison={comparisons?.errors}
		value={loading ? '—' : `${errorRate.toFixed(2)}%`}
		hint={loading ? undefined : `${inFlightRate.toFixed(2)}% in flight`}
	/>
</StatGrid>

<!-- One grid keeps all six cards equally tall, even when toolbars wrap or tabs change. -->
<div use:fitCards style:--analytics-body-growth={`${bodyGrowth}px`} class="grid grid-cols-1 items-stretch gap-[var(--analytics-gap)] lg:auto-rows-fr lg:grid-cols-2 [&>*]:min-w-0">
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
						{#if showTick(i, Math.max(1, Math.ceil(timeline.length / Math.max(2, Math.floor(areaInnerW / 75)))), timeline.length)}
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
                            <div class="mt-1 text-[11.5px] text-zinc-300 tabular-nums">{(outcomeCounts[areaHover]?.[failedOutcomeIndex] ?? 0).toLocaleString()} failed / {point.requests.toLocaleString()} requests</div>
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
            {:else if providerBuckets.length === 0}
				<div class="flex h-[calc(160px+var(--analytics-body-growth,0px))] items-center justify-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{:else}
				<svg width={barWidth} height={BAR_H} role="img" aria-label="{providerTitle} over {range.label.toLowerCase()} · {providerView === 'share' ? 'share' : 'amount'}">
					{#each [0, 0.5, 1] as tick (tick)}
						{@const y = BAR_PAD.top + barInnerH * tick}
						<line x1={BAR_PAD.left} y1={y} x2={barWidth - BAR_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={BAR_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{providerView === 'share' ? `${Math.round(providerMax * (1 - tick))}%` : providerMetric === 'cost_total' ? money(providerMax * (1 - tick)) : fmt(Math.round(providerMax * (1 - tick)))}
						</text>
					{/each}

					{#each stacks as stack, bucketIndex (providerBuckets[bucketIndex])}
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
						{#if showTick(bucketIndex, Math.max(1, Math.ceil(providerBuckets.length / 6)), providerBuckets.length)}
							<text x={cx} y={BAR_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
								{bucketLabel(providerBuckets[bucketIndex] ?? null)}
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
						<div class="mb-1 text-[10.5px] text-zinc-500">{bucketLabel(providerBuckets[barHover] ?? null)}</div>
						{#each stacks[barHover]! as segment (segment.series.id)}
							<div class="flex items-center gap-2 text-[11.5px] whitespace-nowrap">
								<span class="size-[7px] flex-none rounded-full" style:background={segment.series.color}></span>
								<span class="flex-1 text-zinc-500">{segment.series.label}</span>
								<span class="text-zinc-200 tabular-nums">{providerMetric === 'cost_total' ? money(segment.value) : segment.value.toLocaleString()} <span class="text-zinc-500">· {(providerTotals[barHover] ?? 0) > 0 ? `${segment.share.toFixed(1)}%` : '—'}</span></span>
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
                {@const previousValue = previousCallerValues.get(JSON.stringify([caller.actor_type, caller.actor_id])) ?? 0}
                {@const delta = caller.value - previousValue}
                {@const comparison = periodComparison(caller.value, previousValue, { label: comparisonLabel, lowerIsBetter: callerMetric === 'cost_total' })}
				<!-- Opens the users behind this caller on the Users tab. -->
				<a
					href="/analytics/users?actor={caller.actor_id}"
					title="See the users behind {caller.actor_label ?? 'this caller'}"
					class="grid grid-cols-[minmax(80px,1.1fr)_minmax(0,1fr)_64px_100px] items-center gap-3 rounded-[4px] hover:bg-surface-6"
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<!--
							The kind of credential, not decoration: a key and a human are
							different things to hold accountable for the same spend.
						-->
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
                        <span class="text-right text-[12px] leading-[13px] text-zinc-400 tabular-nums" title={callerComparisonUnavailable ? 'Comparison unavailable' : `Previous: ${callerAmount(previousValue)}. Current: ${callerAmount(caller.value)}. ${comparison.title}`}>
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
