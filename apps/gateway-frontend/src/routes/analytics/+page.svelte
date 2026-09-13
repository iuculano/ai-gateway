<script lang="ts">
import { fetchSeries, type SeriesPoint } from '$lib/api/analytics';
import { outcomes, outcomeBuckets } from '$lib/data/chart-series';
import SpendChart from '$lib/components/analytics/spend-chart.svelte';
import ModelComparison from '$lib/components/analytics/model-comparison.svelte';
import FilterPicker from '$lib/components/analytics/filter-picker.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import { rankCallers, type CallerMetric } from '$lib/data/caller-ranking';
import ChartCard from '$lib/components/app/chart-card.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { fmt, fmtCostTotal } from '$lib/data/format';
import { periodComparison } from '$lib/data/analytics-comparison';

// Chart ink. Chrome comes from the app's own tokens so the cards match the rest
// of the dashboard; only the DATA colours come from the validated palette.
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const ACCENT = '#10b981';

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

// 30 days is the default rather than the 14 the mock claimed: the window has to
// be wide enough that the shape of a workload is visible, and a fortnight of a
// bursty gateway is mostly noise.
const DEFAULT_RANGE = { id: '30d' as const, label: 'Last 30 days', days: 30, interval: 'day' as const };

const RANGES = [
  { id: '24h' as const, label: 'Last 24 hours', days: 1, interval: 'hour' as const },
  { id: '7d' as const, label: 'Last 7 days', days: 7, interval: 'day' as const },
  { id: '14d' as const, label: 'Last 14 days', days: 14, interval: 'day' as const },
  DEFAULT_RANGE,
];

let rangeId = $state<(typeof RANGES)[number]['id']>(DEFAULT_RANGE.id);
let rangeOpen = $state(false);
const range = $derived(RANGES.find((r) => r.id === rangeId) ?? DEFAULT_RANGE);

let providerFilter = $state('');
let modelFilter = $state('');
let filterPoints = $state<SeriesPoint[]>([]);
let filtersLoading = $state(true);
let filtersError = $state(false);
let filterRequest = 0;
const providerOptions = $derived([...new Set(filterPoints.flatMap((point) => point.provider ? [point.provider] : []))].sort());
const modelOptions = $derived([...new Set(filterPoints
  .filter((point) => !providerFilter || point.provider === providerFilter)
  .flatMap((point) => point.model ? [point.model] : []))].sort());

function setProvider(value: string) {
  providerFilter = value;
  modelFilter = '';
}

/** Keep options independent of the selected filters, including prior-period activity. */
async function loadFilterOptions() {
  const request = ++filterRequest;
  filtersLoading = true;
  filtersError = false;
  const end = Date.now();
  const days = range.days;
  try {
    const result = await fetchSeries({
      start_date: new Date(end - 2 * days * 86_400_000).toISOString(),
      end_date: new Date(end).toISOString(),
      interval: 'none',
      group_by: ['provider', 'model'],
    });
    if (request === filterRequest) filterPoints = result.points;
  } catch {
    if (request === filterRequest) filtersError = true;
  } finally {
    if (request === filterRequest) filtersLoading = false;
  }
}

$effect(() => {
  void range.id;
  void loadFilterOptions();
});

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
let callerPoints: SeriesPoint[] = $state([]);
let callerMetric = $state<CallerMetric>('requests');
const callerViews = [{ id: 'requests', label: 'Requests' }, { id: 'cost_total', label: 'Spend' }] satisfies { id: CallerMetric; label: string }[];
const topCallers = $derived(rankCallers(callerPoints, callerMetric));
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

  const end = Date.now();
  const duration = range.days * 86_400_000;
  const start = new Date(end - duration).toISOString();
  const filters = { provider: providerFilter || undefined, model: modelFilter || undefined };
  const common = { ...filters, start_date: start, end_date: new Date(end).toISOString() };
  const previous = { ...filters, start_date: new Date(end - 2 * duration).toISOString(), end_date: start };

  try {
    const [totalsResponse, statusResponse, series, providers, models, callers, comparison, failuresByModel, statusTimeline] = await Promise.all([
      fetchSeries({ ...common, interval: 'none' }),
      fetchSeries({ ...common, interval: 'none', group_by: ['status'] }),
      fetchSeries({ ...common, interval: range.interval }),
      fetchSeries({ ...common, interval: range.interval, group_by: ['provider'] }),
      fetchSeries({ ...common, interval: 'none', group_by: ['provider', 'model'] }),
      fetchSeries({ ...common, interval: 'none', group_by: ['actor'] }),
      // A failed comparison must not hide the current charts.
      Promise.allSettled([
        fetchSeries({ ...previous, interval: 'none' }),
        fetchSeries({ ...previous, interval: 'none', group_by: ['status'] }),
      ]),
      fetchSeries({ ...common, interval: 'none', group_by: ['provider', 'model'], status: 'failed' }),
      fetchSeries({ ...common, interval: range.interval, group_by: ['status'] }),
    ]);
    if (request !== loadRequest) return;
    totals = totalsResponse.points[0] ?? null;
    byStatus = statusResponse.points;
    timeline = series.points;
    outcomePoints = statusTimeline.points;
    providerPoints = providers.points;
    modelPoints = models.points;
    modelFailures = failuresByModel.points;
    callerPoints = callers.points;
    const [previousTotalResult, previousStatusResult] = comparison;
    if (previousTotalResult.status === 'fulfilled' && previousStatusResult.status === 'fulfilled') {
      previousTotals = previousTotalResult.value.points[0] ?? null;
      previousStatuses = previousStatusResult.value.points;
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

const comparisons = $derived.by(() => {
  if (loading || loadError) return undefined;
  const label = `the previous ${range.days === 1 ? '24 hours' : `${range.days} days`}`;
  if (comparisonError) {
    const unavailable = { text: 'Unavailable', color: '#a1a1aa', title: `Could not load ${label}.` };
    return { requests: unavailable, spend: unavailable, latency: unavailable, errors: unavailable };
  }
  const previousRequests = previousTotals?.requests ?? null;
  const previousFailed = previousStatuses.find((point) => point.status === 'failed')?.requests ?? 0;
  const previousErrorRate = previousRequests ? (previousFailed / previousRequests) * 100 : null;
  return {
    requests: periodComparison(requestTotal, previousRequests, { label }),
    spend: periodComparison(totals?.cost_total ?? 0, previousTotals?.cost_total ?? null, { label, lowerIsBetter: true }),
    latency: periodComparison(totals?.average_latency_ms ?? null, previousTotals?.average_latency_ms ?? null, { label, lowerIsBetter: true }),
    errors: periodComparison(requestTotal > 0 ? errorRate : null, previousErrorRate, { label, lowerIsBetter: true, percentagePoints: true }),
  };
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return range.interval === 'hour'
    ? `${String(date.getHours()).padStart(2, '0')}:00`
    : `${MONTHS[date.getMonth()]} ${date.getDate()}`;
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

// ---- requests over time (single series, area) --------------------------------
const AREA_H = 210;
const AREA_PAD = { top: 14, right: 10, bottom: 24, left: 52 };

let areaWidth = $state(720);
let areaHover = $state<number | null>(null);

const requestsMax = $derived(niceMax(Math.max(1, ...timeline.map((d) => d.requests))));
const areaInnerW = $derived(Math.max(1, areaWidth - AREA_PAD.left - AREA_PAD.right));
const areaInnerH = AREA_H - AREA_PAD.top - AREA_PAD.bottom;

const areaX = (i: number) => AREA_PAD.left + (i / Math.max(1, timeline.length - 1)) * areaInnerW;
const areaY = (v: number) => AREA_PAD.top + areaInnerH - (v / requestsMax) * areaInnerH;

const outcomeAreas = $derived(outcomes.map((outcome, index) => {
  const upper = timeline.map((_, i) => `${i === 0 ? 'M' : 'L'}${areaX(i)},${areaY(outcomeCounts[i]!.slice(0, index + 1).reduce((a, b) => a + b, 0))}`);
  const lower = timeline.map((_, i) => `L${areaX(i)},${areaY(outcomeCounts[i]!.slice(0, index).reduce((a, b) => a + b, 0))}`).reverse();
  return { ...outcome, path: [...upper, ...lower, 'Z'].join(' ') };
}));
$effect(() => { void timeline; areaHover = null; });

function onAreaMove(event: MouseEvent) {
  if (timeline.length === 0) return;
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - AREA_PAD.left) / areaInnerW;
  areaHover = Math.max(0, Math.min(timeline.length - 1, Math.round(ratio * (timeline.length - 1))));
}

// ---- provider split (stacked bars, categorical) -------------------------------
const BAR_H = 200;
const BAR_PAD = { top: 12, right: 8, bottom: 24, left: 46 };
/** A 2px gap between stacked segments so touching fills stay separable. */
const SEGMENT_GAP = 2;

let barWidth = $state(360);
let barHover = $state<number | null>(null);
let providerView = $state<'volume' | 'share'>('volume');
const providerViews = [{ id: 'volume', label: 'Volume' }, { id: 'share', label: 'Share' }] satisfies { id: typeof providerView; label: string }[];

/** Buckets on the x axis, in time order. */
const providerBuckets = $derived([...new Set(providerPoints.map((p) => p.bucket ?? ''))].sort());

/**
 * Providers present in the window, ordered by total volume.
 *
 * The ORDER decides stacking, not colour - each provider's hue is fixed by name
 * above, so this can be re-sorted freely without any series changing colour.
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
    table.set(`${point.bucket ?? ''}|${point.provider ?? 'unknown'}`, point.requests);
  }
  return table;
});

const providerTotals = $derived(
  providerBuckets.map((bucket) =>
    providerSeries.reduce((sum, series) => sum + (providerLookup.get(`${bucket}|${series.id}`) ?? 0), 0),
  ),
);
const providerMax = $derived(providerView === 'share' ? 100 : niceMax(Math.max(1, ...providerTotals)));
const barInnerW = $derived(Math.max(1, barWidth - BAR_PAD.left - BAR_PAD.right));
const barInnerH = BAR_H - BAR_PAD.top - BAR_PAD.bottom;
const barSlot = $derived(barInnerW / Math.max(1, providerBuckets.length));
const barThickness = $derived(Math.min(28, barSlot * 0.62));

/** Segment rectangles per bucket, stacked from the baseline up. */
const stacks = $derived(
  providerBuckets.map((bucket, bucketIndex) => {
    let cursor = 0;
    return providerSeries.map((series) => {
      const value = providerLookup.get(`${bucket}|${series.id}`) ?? 0;
      const share = providerTotals[bucketIndex]! > 0 ? value / providerTotals[bucketIndex]! * 100 : 0;
      const height = ((providerView === 'share' ? share : value) / providerMax) * barInnerH;
      const y = BAR_PAD.top + barInnerH - cursor - height;
      cursor += height;
      return { series, value, share, y, height: Math.max(0, height - (providerView === 'share' ? 0 : SEGMENT_GAP)) };
    });
  }),
);

// ---- average latency over time (single series, line) --------------------------
//
// Average, not percentiles. The rollup stores a latency sum and a count, which
// reconstruct a mean exactly; a p95 cannot be recovered from stored p95s by any
// arithmetic, so drawing one here would mean inventing it. That needs a latency
// histogram, which is deliberately not in this iteration.
const LAT_H = 200;
const LAT_PAD = { top: 12, right: 12, bottom: 24, left: 46 };

let latWidth = $state(360);
let latHover = $state<number | null>(null);
let latencyView = $state<'overall' | 'providers'>('overall');
const latencyViews = [{ id: 'overall', label: 'Overall' }, { id: 'providers', label: 'By provider' }] satisfies { id: typeof latencyView; label: string }[];

const latPoints = $derived(timeline);
const latencySeries = $derived(latencyView === 'overall'
  ? [{ id: 'overall', label: 'Overall', color: '#3987e5', values: timeline.map(point => point.average_latency_ms) }]
  : providerSeries.map(series => ({ ...series, values: timeline.map(point => providerPoints.find(p => p.bucket === point.bucket && (p.provider ?? 'unknown') === series.id)?.average_latency_ms ?? null) })));
const hasLatency = $derived(latencySeries.some(series => series.values.some(value => value !== null)));
const latMax = $derived(niceMax(Math.max(1, ...latencySeries.flatMap(series => series.values.map(value => value ?? 0)))));
const latInnerW = $derived(Math.max(1, latWidth - LAT_PAD.left - LAT_PAD.right));
const latInnerH = LAT_H - LAT_PAD.top - LAT_PAD.bottom;

const latX = (i: number) => LAT_PAD.left + (i / Math.max(1, latPoints.length - 1)) * latInnerW;
const latY = (v: number) => LAT_PAD.top + latInnerH - (v / latMax) * latInnerH;

const latencyPaths = $derived(latencySeries.map(series => {
  let connected = false;
  const path = series.values.map((value, i) => {
    if (value === null) { connected = false; return ''; }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${latX(i)},${latY(value)}`;
  }).join(' ');
  return { ...series, path };
}));
$effect(() => { void timeline; void latencyView; latHover = null; });
$effect(() => { void providerPoints; void providerView; barHover = null; });

function onLatMove(event: MouseEvent) {
  if (latPoints.length === 0) return;
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - LAT_PAD.left) / latInnerW;
  latHover = Math.max(0, Math.min(latPoints.length - 1, Math.round(ratio * (latPoints.length - 1))));
}

// ---- ranked lists (single hue - length already encodes the value) -------------

</script>

<PageHeader title="Analytics" description="Traffic, spend and latency across every model routed through Relay.">
	{#snippet actions()}
		<FilterPicker id="analytics-provider" label="Provider" options={providerOptions} bind:value={() => providerFilter, setProvider} class="w-40" />
		<FilterPicker id="analytics-model" label="Model" options={modelOptions} bind:value={modelFilter} class="w-52" />
		{#if filtersLoading}<span class="text-xs text-zinc-500" role="status">Loading filters…</span>{/if}
		{#if filtersError}<ToolbarButton onclick={loadFilterOptions}>Retry filters</ToolbarButton>{/if}
		<div class="relative">
			<ToolbarButton onclick={() => (rangeOpen = !rangeOpen)}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" /><path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
				{range.label}
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="ml-0.5"><path d="M5 6.5L8 9.5L11 6.5" stroke="#71717a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</ToolbarButton>

			{#if rangeOpen}
				<div class="absolute right-0 z-20 mt-1.5 w-[168px] overflow-hidden rounded-lg border border-line-strong bg-surface-5 py-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
					{#each RANGES as option (option.id)}
						<button
							type="button"
							class="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-6 {option.id ===
							rangeId
								? 'text-zinc-100'
								: 'text-zinc-400'}"
							onclick={() => {
								rangeId = option.id;
								rangeOpen = false;
							}}
						>
							{option.label}
							{#if option.id === rangeId}
								<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke={ACCENT} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}
</PageHeader>

{#if loadError}
	<div class="mb-3.5 flex items-center gap-[9px] rounded-lg border border-red-500/20 bg-red-500/7 px-[13px] py-2.5">
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="flex-none"><circle cx="8" cy="8" r="6.3" stroke="#ef4444" stroke-width="1.4" /><path d="M8 4.8v3.6M8 11v.01" stroke="#ef4444" stroke-width="1.4" stroke-linecap="round" /></svg>
		<span class="text-[12.5px] text-[#e0a0a0]">{loadError}</span>
	</div>
{/if}

<StatGrid>
	<StatCard label="Requests · {range.label.replace('Last ', '')}" value={loading ? '—' : fmt(requestTotal)} comparison={comparisons?.requests} />
	<StatCard label="Spend" value={loading ? '—' : fmtCostTotal(totals?.cost_total ?? 0)} comparison={comparisons?.spend} />
	<StatCard
		label="Average latency"
		comparison={comparisons?.latency}
		value={loading || !totals?.average_latency_ms ? '—' : `${(totals.average_latency_ms / 1000).toFixed(2)}s`}
	/>
	<StatCard
		label="Error rate"
		comparison={comparisons?.errors}
		value={loading ? '—' : `${errorRate.toFixed(2)}%`}
		hint={loading ? undefined : `${inFlightRate.toFixed(2)}% in flight`}
		accent={errorRate > 5 ? '#ef4444' : '#0ca30c'}
	/>
</StatGrid>

<!-- Traffic and spend share a row for direct comparison. -->
<div class="mb-3.5 grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2 [&>*]:min-w-0">
	<ChartCard title="Requests over time" hint="Success · incomplete · failed">
		<div class="relative" bind:clientWidth={areaWidth}>
			{#if loading}
                <div class="flex h-[210px] items-center justify-center text-[12.5px] text-zinc-600">Loading requests…</div>
            {:else if timeline.length === 0}
				<div class="flex h-[210px] items-center justify-center text-[12.5px] text-zinc-600">
					No requests in this window.
				</div>
			{:else}
				<svg
					width={areaWidth}
					height={AREA_H}
					role="img"
					aria-label="Request volume over {range.label.toLowerCase()}"
					onmousemove={onAreaMove}
					onmouseleave={() => (areaHover = null)}
				>

					{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
						{@const y = AREA_PAD.top + areaInnerH * tick}
						<line x1={AREA_PAD.left} y1={y} x2={areaWidth - AREA_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={AREA_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{fmt(Math.round(requestsMax * (1 - tick)))}
						</text>
					{/each}

                        {#each outcomeAreas as series, index (series.id)}
                            {#if timeline.length === 1}
                                {@const upper = outcomeCounts[0]!.slice(0, index + 1).reduce((a, b) => a + b, 0)}
                                <rect x={AREA_PAD.left} y={areaY(upper)} width={Math.min(32, areaInnerW)} height={outcomeCounts[0]![index]! / requestsMax * areaInnerH} fill={series.color} />
                            {:else}
                                <path d={series.path} fill={series.color} fill-opacity="0.65" stroke={series.color} stroke-width="1" />
                            {/if}
                        {/each}

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
							<span class="size-[7px] rounded-full" style:background={ACCENT}></span>
							<span class="tabular-nums">{point.requests.toLocaleString()}</span>
							<span class="text-zinc-600">requests</span>
						</div>

                            {#each outcomes as outcome, index (outcome.id)}
                                <div class="mt-1 flex justify-between gap-4 text-[11.5px]" style:color={outcome.color}><span>{outcome.label}</span><span class="tabular-nums">{outcomeCounts[areaHover]?.[index]?.toLocaleString() ?? '0'}</span></div>
                            {/each}
                        <div class="mt-0.5 text-[11.5px] whitespace-nowrap text-zinc-500 tabular-nums">
							{fmtCostTotal(point.cost_total)}
							{#if point.average_latency_ms !== null}
								· {point.average_latency_ms}ms avg
							{/if}
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>
	<SpendChart interval={range.interval} points={timeline} {loading} rangeLabel={range.label} {bucketLabel} />
</div>

<div class="mb-3.5 grid grid-cols-2 items-start gap-3.5">
	<!-- provider split -->
	<ChartCard title="Requests by provider" hint={providerView === 'share' ? 'Percentage of requests per bucket.' : 'Stacked per bucket.'}>
        {#snippet actions()}<FilterTabs tabs={providerViews} bind:value={providerView} />{/snippet}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				{#each providerSeries as series (series.id)}
					<span class="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
						<span class="size-[7px] flex-none rounded-full" style:background={series.color}></span>
						{series.label}
					</span>
				{/each}
			</div>

		<div class="relative" bind:clientWidth={barWidth}>
			{#if !loading && providerBuckets.length === 0}
				<div class="flex h-[200px] items-center justify-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{:else}
				<svg width={barWidth} height={BAR_H} role="img" aria-label="Requests by provider over {range.label.toLowerCase()}">
					{#each [0, 0.5, 1] as tick (tick)}
						{@const y = BAR_PAD.top + barInnerH * tick}
						<line x1={BAR_PAD.left} y1={y} x2={barWidth - BAR_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={BAR_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{providerView === 'share' ? `${Math.round(providerMax * (1 - tick))}%` : fmt(Math.round(providerMax * (1 - tick)))}
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
								<span class="text-zinc-200 tabular-nums">{segment.value.toLocaleString()} <span class="text-zinc-500">· {segment.share.toFixed(1)}%</span></span>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>

	<!-- average latency -->
	<ChartCard title="Average latency" hint="Average response time in milliseconds.">
        {#snippet actions()}<FilterTabs tabs={latencyViews} bind:value={latencyView} />{/snippet}
        {#if latencyView === 'providers'}
            <div class="flex flex-wrap gap-x-3 gap-y-1.5">
                {#each latencySeries as series (series.id)}<span class="flex items-center gap-1.5 text-[11.5px] text-zinc-400"><span class="size-[7px] rounded-full" style:background={series.color}></span>{series.label}</span>{/each}
            </div>
        {/if}
		<div class="relative" bind:clientWidth={latWidth}>
			{#if loading}
                <div class="flex h-[200px] items-center justify-center text-[12.5px] text-zinc-600">Loading latency…</div>
            {:else if !hasLatency}
				<div class="flex h-[200px] items-center justify-center text-[12.5px] text-zinc-600">No latency recorded.</div>
			{:else}
				<svg
					width={latWidth}
					height={LAT_H}
					role="img"
					aria-label="Average latency over {range.label.toLowerCase()}"
					onmousemove={onLatMove}
					onmouseleave={() => (latHover = null)}
				>
					{#each [0, 0.5, 1] as tick (tick)}
						{@const y = LAT_PAD.top + latInnerH * tick}
						<line x1={LAT_PAD.left} y1={y} x2={latWidth - LAT_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={LAT_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{Math.round(latMax * (1 - tick))}
						</text>
					{/each}

					{#each latencyPaths as series (series.id)}
                        <path d={series.path} fill="none" stroke={series.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                        {#each series.values as value, i}
                            {#if value !== null}<circle cx={latX(i)} cy={latY(value)} r={latHover === i ? 4 : 2} fill={series.color} />{/if}
                        {/each}
                    {/each}

					{#each latPoints as point, i (point.bucket)}
						{#if showTick(i, Math.max(1, Math.ceil(latPoints.length / 5)), latPoints.length)}
							<text x={latX(i)} y={LAT_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
								{bucketLabel(point.bucket)}
							</text>
						{/if}
					{/each}

				</svg>

				{#if latHover !== null && latPoints[latHover]}
					{@const point = latPoints[latHover]!}
					<div
						class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
						style:left="{Math.min(Math.max(latX(latHover), 80), latWidth - 80)}px"
					>
						<div class="mb-1 text-[10.5px] text-zinc-500">{bucketLabel(point.bucket)}</div>
                        {#each latencySeries as series (series.id)}
                            <div class="flex justify-between gap-4 text-[12px] whitespace-nowrap" style:color={series.color}><span>{series.label}</span><span class="tabular-nums">{series.values[latHover] == null ? '—' : `${series.values[latHover]!.toLocaleString('en-US', { maximumFractionDigits: 1 })}ms`}</span></div>
                        {/each}
                        {#if latencyView === 'overall' && point.minimum_latency_ms !== null && point.maximum_latency_ms !== null}
                            <div class="mt-0.5 text-[11.5px] whitespace-nowrap text-zinc-500 tabular-nums">{point.minimum_latency_ms}–{point.maximum_latency_ms}ms range</div>
                        {/if}
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>
</div>

<div class="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2 [&>*]:min-w-0">
	<ModelComparison points={modelPoints} failures={modelFailures} {loading} />

	<!-- top callers -->
	<ChartCard title="Top callers" hint={callerMetric === 'requests' ? 'By request volume · share of all requests' : 'By spend · share of total spend'}>
        {#snippet actions()}<FilterTabs tabs={callerViews} bind:value={callerMetric} />{/snippet}
		<div class="flex flex-col gap-2.5">
			{#if loading}
                <div class="py-8 text-center text-[12.5px] text-zinc-600">Loading callers…</div>
            {:else}
            {#each topCallers as caller (`${caller.actor_type}-${caller.actor_id}`)}
				<div class="grid grid-cols-[minmax(80px,1.1fr)_minmax(0,1fr)_64px_50px] items-center gap-3">
					<span class="flex min-w-0 items-center gap-1.5">
						<!--
							The kind of credential, not decoration: a key and a human are
							different things to hold accountable for the same spend.
						-->
						<span
							class="flex-none rounded-[3px] px-1 py-[1px] text-[9.5px] tracking-wide uppercase {caller.actor_type ===
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
					<span class="text-right text-[12.5px] text-zinc-500 tabular-nums" title={callerMetric === 'requests' ? 'Share of all requests' : 'Share of total spend'}>{caller.share === null ? '—' : caller.share > 0 && caller.share < 0.1 ? '<0.1%' : `${caller.share.toFixed(1)}%`}</span>
				</div>
			{:else}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{/each}
            {/if}
		</div>
	</ChartCard>
</div>
