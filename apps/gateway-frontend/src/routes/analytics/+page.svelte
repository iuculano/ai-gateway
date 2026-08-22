<script lang="ts">
import { fetchSeries, type SeriesPoint } from '$lib/api/analytics';
import ChartCard from '$lib/components/app/chart-card.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { fmt, fmtCostTotal } from '$lib/data/format';

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

let loading = $state(true);
let loadError = $state<string | null>(null);
let sealedThrough = $state<string | null>(null);

let totals = $state<SeriesPoint | null>(null);
let byStatus: SeriesPoint[] = $state([]);
let timeline: SeriesPoint[] = $state([]);
let providerPoints: SeriesPoint[] = $state([]);
let topModels: SeriesPoint[] = $state([]);
let topCallers: SeriesPoint[] = $state([]);

/**
 * Loads every panel for the current range.
 *
 * Six requests rather than one composite endpoint, issued together. Each is a
 * different pivot of the same rollup and costs about 10 ms, so the round trip
 * dominates - and one panel failing to shape its query does not take the page
 * down with it.
 */
async function load() {
  loading = true;
  loadError = null;

  const start = new Date(Date.now() - range.days * 86_400_000).toISOString();
  const common = { start_date: start };

  try {
    const [totalsResponse, statusResponse, series, providers, models, callers] = await Promise.all([
      fetchSeries({ ...common, interval: 'none' }),
      fetchSeries({ ...common, interval: 'none', group_by: ['status'] }),
      fetchSeries({ ...common, interval: range.interval }),
      fetchSeries({ ...common, interval: range.interval, group_by: ['provider'] }),
      fetchSeries({ ...common, interval: 'none', group_by: ['model'], limit: 6 }),
      fetchSeries({ ...common, interval: 'none', group_by: ['actor'], limit: 6 }),
    ]);

    totals = totalsResponse.points[0] ?? null;
    byStatus = statusResponse.points;
    timeline = series.points;
    providerPoints = providers.points;
    topModels = models.points;
    topCallers = callers.points;
    sealedThrough = series.sealed_through;
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Failed to load analytics.';
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Referenced so the effect re-runs when the range changes.
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

const sealedLabel = $derived(
  sealedThrough
    ? new Date(sealedThrough).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null,
);

/**
 * How far the rollup worker is behind, in hours.
 *
 * NOT a correctness signal - the endpoint merges the sealed rollup with raw
 * rows for anything newer, so these figures are current either way. It is an
 * operational one: the further behind the worker is, the more of each query is
 * being answered from `logs` instead of the rollup, and the slower it gets.
 * In the steady state this sits under 1, because the hour in progress is never
 * sealed.
 */
const rollupLagHours = $derived(sealedThrough ? (Date.now() - new Date(sealedThrough).getTime()) / 3_600_000 : 0);

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

const areaLine = $derived(timeline.map((d, i) => `${i === 0 ? 'M' : 'L'}${areaX(i)},${areaY(d.requests)}`).join(' '));
const areaFill = $derived(
  timeline.length === 0
    ? ''
    : `${areaLine} L${areaX(timeline.length - 1)},${AREA_PAD.top + areaInnerH} L${areaX(0)},${AREA_PAD.top + areaInnerH} Z`,
);

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
const providerMax = $derived(niceMax(Math.max(1, ...providerTotals)));
const barInnerW = $derived(Math.max(1, barWidth - BAR_PAD.left - BAR_PAD.right));
const barInnerH = BAR_H - BAR_PAD.top - BAR_PAD.bottom;
const barSlot = $derived(barInnerW / Math.max(1, providerBuckets.length));
const barThickness = $derived(Math.min(28, barSlot * 0.62));

/** Segment rectangles per bucket, stacked from the baseline up. */
const stacks = $derived(
  providerBuckets.map((bucket) => {
    let cursor = 0;
    return providerSeries.map((series) => {
      const value = providerLookup.get(`${bucket}|${series.id}`) ?? 0;
      const height = (value / providerMax) * barInnerH;
      const y = BAR_PAD.top + barInnerH - cursor - height;
      cursor += height;
      return { series, value, y, height: Math.max(0, height - SEGMENT_GAP) };
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

const latPoints = $derived(timeline.filter((d) => d.average_latency_ms !== null));
const latMax = $derived(niceMax(Math.max(1, ...latPoints.map((d) => d.average_latency_ms ?? 0))));
const latInnerW = $derived(Math.max(1, latWidth - LAT_PAD.left - LAT_PAD.right));
const latInnerH = LAT_H - LAT_PAD.top - LAT_PAD.bottom;

const latX = (i: number) => LAT_PAD.left + (i / Math.max(1, latPoints.length - 1)) * latInnerW;
const latY = (v: number) => LAT_PAD.top + latInnerH - (v / latMax) * latInnerH;

const latPath = $derived(
  latPoints.map((d, i) => `${i === 0 ? 'M' : 'L'}${latX(i)},${latY(d.average_latency_ms ?? 0)}`).join(' '),
);

function onLatMove(event: MouseEvent) {
  if (latPoints.length === 0) return;
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - LAT_PAD.left) / latInnerW;
  latHover = Math.max(0, Math.min(latPoints.length - 1, Math.round(ratio * (latPoints.length - 1))));
}

// ---- ranked lists (single hue - length already encodes the value) -------------
const modelMax = $derived(Math.max(1, ...topModels.map((m) => m.requests)));
const callerMax = $derived(Math.max(1, ...topCallers.map((c) => c.requests)));
</script>

<PageHeader title="Analytics" description="Traffic, spend and latency across every model routed through Relay.">
	{#snippet actions()}
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
{:else if !loading && rollupLagHours >= 2}
	<!--
		Nothing is missing from the numbers - the endpoint merges raw rows for
		anything the rollup has not sealed yet. This says the worker is behind,
		which is a performance and ops problem rather than a correctness one, so
		it reads as a caution and not an error.
	-->
	<div class="mb-3.5 flex items-center gap-[9px] rounded-lg border border-amber-500/18 bg-amber-500/7 px-[13px] py-2.5">
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="flex-none"><path d="M8 2.5L14.5 13.5H1.5L8 2.5z" stroke="#f59e0b" stroke-width="1.4" stroke-linejoin="round" /><path d="M8 6.8v3M8 11.6v.01" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" /></svg>
		<span class="text-[12.5px] text-[#d4b483]">
			Figures are current — anything the rollup has not sealed is read live from the request log. But the rollup worker
			last sealed {sealedLabel}, {Math.floor(rollupLagHours)} hours ago, so these queries are doing more work than they
			should.
		</span>
	</div>
{/if}

<StatGrid>
	<StatCard label="Requests · {range.label.replace('Last ', '')}" value={loading ? '—' : fmt(requestTotal)} />
	<StatCard label="Spend" value={loading ? '—' : fmtCostTotal(totals?.cost_total ?? 0)} />
	<StatCard
		label="Average latency"
		value={loading || !totals?.average_latency_ms ? '—' : `${(totals.average_latency_ms / 1000).toFixed(2)}s`}
	/>
	<StatCard
		label="Error rate"
		value={loading ? '—' : `${errorRate.toFixed(2)}%`}
		hint={loading ? undefined : `${inFlightRate.toFixed(2)}% in flight`}
		accent={errorRate > 5 ? '#ef4444' : '#0ca30c'}
	/>
</StatGrid>

<!-- requests over time -->
<div class="mb-3.5">
	<ChartCard title="Requests over time" hint="Totals across all providers. Hover for a breakdown.">
		<div class="relative" bind:clientWidth={areaWidth}>
			{#if !loading && timeline.length === 0}
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
					<defs>
						<linearGradient id="requests-fill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stop-color={ACCENT} stop-opacity="0.22" />
							<stop offset="100%" stop-color={ACCENT} stop-opacity="0" />
						</linearGradient>
					</defs>

					{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
						{@const y = AREA_PAD.top + areaInnerH * tick}
						<line x1={AREA_PAD.left} y1={y} x2={areaWidth - AREA_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={AREA_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{fmt(Math.round(requestsMax * (1 - tick)))}
						</text>
					{/each}

					<path d={areaFill} fill="url(#requests-fill)" />
					<path d={areaLine} fill="none" stroke={ACCENT} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

					{#each timeline as point, i (point.bucket)}
						{#if showTick(i, Math.max(1, Math.ceil(timeline.length / 8)), timeline.length)}
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
						<!-- 2px surface ring so the marker stays separable from the line under it -->
						<circle cx={areaX(areaHover)} cy={areaY(point.requests)} r="5" fill={ACCENT} stroke="#0a0a0c" stroke-width="2" />
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
</div>

<div class="mb-3.5 grid grid-cols-2 items-start gap-3.5">
	<!-- provider split -->
	<ChartCard title="Requests by provider" hint="Stacked per bucket.">
		{#snippet actions()}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				{#each providerSeries as series (series.id)}
					<span class="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
						<span class="size-[7px] flex-none rounded-full" style:background={series.color}></span>
						{series.label}
					</span>
				{/each}
			</div>
		{/snippet}

		<div class="relative" bind:clientWidth={barWidth}>
			{#if !loading && providerBuckets.length === 0}
				<div class="flex h-[200px] items-center justify-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{:else}
				<svg width={barWidth} height={BAR_H} role="img" aria-label="Requests by provider over {range.label.toLowerCase()}">
					{#each [0, 0.5, 1] as tick (tick)}
						{@const y = BAR_PAD.top + barInnerH * tick}
						<line x1={BAR_PAD.left} y1={y} x2={barWidth - BAR_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
						<text x={BAR_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
							{fmt(Math.round(providerMax * (1 - tick)))}
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
								rx="2"
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
								<span class="text-zinc-200 tabular-nums">{segment.value.toLocaleString()}</span>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>

	<!-- average latency -->
	<ChartCard title="Average latency" hint="Milliseconds per bucket, reconstructed from stored sums.">
		<div class="relative" bind:clientWidth={latWidth}>
			{#if !loading && latPoints.length === 0}
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

					<path d={latPath} fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

					{#each latPoints as point, i (point.bucket)}
						{#if showTick(i, Math.max(1, Math.ceil(latPoints.length / 5)), latPoints.length)}
							<text x={latX(i)} y={LAT_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
								{bucketLabel(point.bucket)}
							</text>
						{/if}
					{/each}

					{#if latHover !== null && latPoints[latHover]}
						{@const point = latPoints[latHover]!}
						<circle
							cx={latX(latHover)}
							cy={latY(point.average_latency_ms ?? 0)}
							r="5"
							fill="#3987e5"
							stroke="#0a0a0c"
							stroke-width="2"
						/>
					{/if}
				</svg>

				{#if latHover !== null && latPoints[latHover]}
					{@const point = latPoints[latHover]!}
					<div
						class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
						style:left="{Math.min(Math.max(latX(latHover), 80), latWidth - 80)}px"
					>
						<div class="mb-1 text-[10.5px] text-zinc-500">{bucketLabel(point.bucket)}</div>
						<div class="text-[12.5px] whitespace-nowrap text-zinc-200 tabular-nums">
							{point.average_latency_ms}ms average
						</div>
						<div class="mt-0.5 text-[11.5px] whitespace-nowrap text-zinc-500 tabular-nums">
							{point.minimum_latency_ms}–{point.maximum_latency_ms}ms range
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</ChartCard>
</div>

<div class="grid grid-cols-2 items-start gap-3.5">
	<!-- top models -->
	<ChartCard title="Top models" hint="By request volume. Bar length is the value — one hue throughout.">
		<div class="flex flex-col gap-2.5">
			{#each topModels as model (model.model)}
				<div class="grid grid-cols-[minmax(110px,1.1fr)_minmax(0,2fr)_70px_62px] items-center gap-3">
					<code class="overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-300">
						{model.model}
					</code>
					<div class="h-[18px] w-full">
						<!-- 4px rounded data-end, anchored flat to the baseline at the left -->
						<div
							class="h-full rounded-r-[4px]"
							style:width="{Math.max(2, (model.requests / modelMax) * 100)}%"
							style:background={ACCENT}
							style:opacity={0.35 + 0.65 * (model.requests / modelMax)}
						></div>
					</div>
					<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmt(model.requests)}</span>
					<span class="text-right text-[12.5px] text-zinc-600 tabular-nums">{fmtCostTotal(model.cost_total)}</span>
				</div>
			{:else}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{/each}
		</div>
	</ChartCard>

	<!-- top callers -->
	<ChartCard title="Top callers" hint="By request volume, attributed to the authenticated key or user.">
		<div class="flex flex-col gap-2.5">
			{#each topCallers as caller (`${caller.actor_type}-${caller.actor_id}`)}
				<div class="grid grid-cols-[minmax(110px,1.1fr)_minmax(0,2fr)_70px_62px] items-center gap-3">
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
							{caller.actor_type === 'api_key' ? 'key' : 'user'}
						</span>
						<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-300">
							{caller.actor_label}
						</span>
					</span>
					<div class="h-[18px] w-full">
						<div
							class="h-full rounded-r-[4px]"
							style:width="{Math.max(2, (caller.requests / callerMax) * 100)}%"
							style:background={ACCENT}
							style:opacity={0.35 + 0.65 * (caller.requests / callerMax)}
						></div>
					</div>
					<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{fmt(caller.requests)}</span>
					<span class="text-right text-[12.5px] text-zinc-600 tabular-nums">{fmtCostTotal(caller.cost_total)}</span>
				</div>
			{:else}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">No requests in this window.</div>
			{/each}
		</div>
	</ChartCard>
</div>
