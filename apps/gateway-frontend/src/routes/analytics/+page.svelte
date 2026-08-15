<script lang="ts">
import ChartCard from '$lib/components/app/chart-card.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { DAILY, PROVIDER_DAYS, PROVIDER_SPLIT, SUMMARY, TOP_MODELS } from '$lib/data/analytics-mock';
import { fmt, fmtCostTotal } from '$lib/data/format';

// Chart ink. Chrome comes from the app's own tokens so the cards match the rest
// of the dashboard; only the DATA colours come from the validated palette.
const GRID = '#1f1f23';
const AXIS_INK = '#52525b';
const ACCENT = '#10b981';

/**
 * Ordinal ramp for the latency percentiles - one hue, monotone lightness.
 *
 * Percentiles are ordered, so the colour has to carry that order; a categorical
 * set here would say "three unrelated things". Lighter reads as further out
 * because this is a dark surface, which puts p99 - the number you actually
 * chase - on top.
 */
const LATENCY_SERIES = [
  { key: 'p50' as const, label: 'p50', color: '#1c5cab' },
  { key: 'p95' as const, label: 'p95', color: '#3987e5' },
  { key: 'p99' as const, label: 'p99', color: '#86b6ef' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * Whether to draw an x-axis label at this index.
 *
 * Every `every`th tick, plus the last one - but a regular tick is suppressed
 * when the last one would land on top of it. With 14 points and a step of 4 the
 * 12th tick sits ~21px from the end label, which is narrower than the label
 * itself once the card is in a two-column row.
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
const AREA_PAD = { top: 14, right: 10, bottom: 24, left: 46 };

let areaWidth = $state(720);
let areaHover: number | null = $state(null);

const requestsMax = $derived(niceMax(Math.max(...DAILY.map((d) => d.requests))));
const areaInnerW = $derived(Math.max(1, areaWidth - AREA_PAD.left - AREA_PAD.right));
const areaInnerH = AREA_H - AREA_PAD.top - AREA_PAD.bottom;

const areaX = (i: number) => AREA_PAD.left + (i / (DAILY.length - 1)) * areaInnerW;
const areaY = (v: number) => AREA_PAD.top + areaInnerH - (v / requestsMax) * areaInnerH;

const areaLine = $derived(DAILY.map((d, i) => `${i === 0 ? 'M' : 'L'}${areaX(i)},${areaY(d.requests)}`).join(' '));
const areaFill = $derived(
  `${areaLine} L${areaX(DAILY.length - 1)},${AREA_PAD.top + areaInnerH} L${areaX(0)},${AREA_PAD.top + areaInnerH} Z`,
);

function onAreaMove(event: MouseEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left - AREA_PAD.left) / areaInnerW;
  areaHover = Math.max(0, Math.min(DAILY.length - 1, Math.round(ratio * (DAILY.length - 1))));
}

// ---- provider split (stacked bars, categorical) -------------------------------
const BAR_H = 200;
const BAR_PAD = { top: 12, right: 8, bottom: 24, left: 40 };
/** A 2px gap between stacked segments so touching fills stay separable. */
const SEGMENT_GAP = 2;

let barWidth = $state(360);
let barHover: number | null = $state(null);

const providerTotals = $derived(
  PROVIDER_DAYS.map((_, i) => PROVIDER_SPLIT.reduce((sum, s) => sum + (s.daily[i] ?? 0), 0)),
);
const providerMax = $derived(niceMax(Math.max(...providerTotals)));
const barInnerW = $derived(Math.max(1, barWidth - BAR_PAD.left - BAR_PAD.right));
const barInnerH = BAR_H - BAR_PAD.top - BAR_PAD.bottom;
const barSlot = $derived(barInnerW / PROVIDER_DAYS.length);
const barThickness = $derived(Math.min(28, barSlot * 0.62));

/** Segment rectangles per day, stacked from the baseline up. */
const stacks = $derived(
  PROVIDER_DAYS.map((_, dayIndex) => {
    let cursor = 0;
    return PROVIDER_SPLIT.map((series) => {
      const value = series.daily[dayIndex] ?? 0;
      const height = (value / providerMax) * barInnerH;
      const y = BAR_PAD.top + barInnerH - cursor - height;
      cursor += height;
      return { series, value, y, height: Math.max(0, height - SEGMENT_GAP) };
    });
  }),
);

// ---- latency percentiles (multi-line, ordinal) --------------------------------
const LAT_H = 200;
const LAT_PAD = { top: 12, right: 40, bottom: 24, left: 44 };

let latWidth = $state(360);

const latMax = $derived(niceMax(Math.max(...DAILY.map((d) => d.p99))));
const latInnerW = $derived(Math.max(1, latWidth - LAT_PAD.left - LAT_PAD.right));
const latInnerH = LAT_H - LAT_PAD.top - LAT_PAD.bottom;

const latX = (i: number) => LAT_PAD.left + (i / (DAILY.length - 1)) * latInnerW;
const latY = (v: number) => LAT_PAD.top + latInnerH - (v / latMax) * latInnerH;

const latPaths = $derived(
  LATENCY_SERIES.map((s) => {
    const values = DAILY.map((d) => d[s.key]);
    return {
      ...s,
      d: values.map((v, i) => `${i === 0 ? 'M' : 'L'}${latX(i)},${latY(v)}`).join(' '),
      endY: latY(values[values.length - 1] ?? 0),
    };
  }),
);

// ---- top models (single hue - length already encodes the value) ---------------
const modelMax = $derived(Math.max(...TOP_MODELS.map((m) => m.requests)));
</script>

<PageHeader
	title="Analytics"
	description="Traffic, spend and latency across every model routed through Relay."
>
	{#snippet actions()}
		<ToolbarButton>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" /><path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			Last 14 days
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="ml-0.5"><path d="M5 6.5L8 9.5L11 6.5" stroke="#71717a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</ToolbarButton>
		<ToolbarButton>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Export
		</ToolbarButton>
	{/snippet}
</PageHeader>

<div class="mb-3.5 flex items-center gap-[9px] rounded-lg border border-amber-500/18 bg-amber-500/7 px-[13px] py-2.5">
	<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="flex-none"><path d="M8 2.5L14.5 13.5H1.5L8 2.5z" stroke="#f59e0b" stroke-width="1.4" stroke-linejoin="round" /><path d="M8 6.8v3M8 11.6v.01" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" /></svg>
	<span class="text-[12.5px] text-[#d4b483]">
		Sample data. There is no analytics endpoint yet — every figure on this page is invented.
	</span>
</div>

<StatGrid>
	<StatCard label="Requests · 14d" value={fmt(SUMMARY.requests)} hint="+{SUMMARY.requestsDelta}%" />
	<StatCard label="Spend · 14d" value={fmtCostTotal(SUMMARY.spend)} hint="+{SUMMARY.spendDelta}%" />
	<StatCard label="Median latency" value="{(SUMMARY.medianLatencyMs / 1000).toFixed(2)}s" hint="{SUMMARY.latencyDelta}%" />
	<StatCard label="Error rate" value="{SUMMARY.errorRate}%" hint="{SUMMARY.errorRateDelta} pts" accent="#0ca30c" />
</StatGrid>

<!-- requests over time -->
<div class="mb-3.5">
	<ChartCard title="Requests over time" hint="Daily totals across all providers. Hover for a breakdown.">
		<div class="relative" bind:clientWidth={areaWidth}>
			<svg
				width={areaWidth}
				height={AREA_H}
				role="img"
				aria-label="Daily request volume over the last 14 days"
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

				{#each DAILY as day, i (day.date)}
					{#if showTick(i, 3, DAILY.length)}
						<text x={areaX(i)} y={AREA_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
							{dayLabel(day.date)}
						</text>
					{/if}
				{/each}

				{#if areaHover !== null}
					{@const day = DAILY[areaHover]!}
					<line
						x1={areaX(areaHover)}
						y1={AREA_PAD.top}
						x2={areaX(areaHover)}
						y2={AREA_PAD.top + areaInnerH}
						stroke="#3f3f46"
						stroke-width="1"
					/>
					<!-- 2px surface ring so the marker stays separable from the line under it -->
					<circle cx={areaX(areaHover)} cy={areaY(day.requests)} r="5" fill={ACCENT} stroke="#0a0a0c" stroke-width="2" />
				{/if}
			</svg>

			{#if areaHover !== null}
				{@const day = DAILY[areaHover]!}
				<div
					class="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
					style:left="{Math.min(Math.max(areaX(areaHover), 70), areaWidth - 70)}px"
				>
					<div class="mb-1 text-[10.5px] text-zinc-500">{dayLabel(day.date)}</div>
					<div class="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-zinc-200">
						<span class="size-[7px] rounded-full" style:background={ACCENT}></span>
						<span class="tabular-nums">{day.requests.toLocaleString()}</span>
						<span class="text-zinc-600">requests</span>
					</div>
					<div class="mt-0.5 text-[11.5px] whitespace-nowrap text-zinc-500 tabular-nums">
						${day.spend.toFixed(2)} · p95 {day.p95}ms
					</div>
				</div>
			{/if}
		</div>
	</ChartCard>
</div>

<div class="mb-3.5 grid grid-cols-2 items-start gap-3.5">
	<!-- provider split -->
	<ChartCard title="Requests by provider" hint="Last 7 days, stacked.">
		{#snippet actions()}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				{#each PROVIDER_SPLIT as series (series.id)}
					<span class="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
						<span class="size-[7px] flex-none rounded-full" style:background={series.color}></span>
						{series.label}
					</span>
				{/each}
			</div>
		{/snippet}

		<div class="relative" bind:clientWidth={barWidth}>
			<svg width={barWidth} height={BAR_H} role="img" aria-label="Requests by provider over the last 7 days">
				{#each [0, 0.5, 1] as tick (tick)}
					{@const y = BAR_PAD.top + barInnerH * tick}
					<line x1={BAR_PAD.left} y1={y} x2={barWidth - BAR_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
					<text x={BAR_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
						{fmt(Math.round(providerMax * (1 - tick)))}
					</text>
				{/each}

				{#each stacks as stack, dayIndex (PROVIDER_DAYS[dayIndex])}
					{@const cx = BAR_PAD.left + barSlot * (dayIndex + 0.5)}
					<!-- Hit target spans the whole slot, not just the bar -->
					<rect
						x={cx - barSlot / 2}
						y={BAR_PAD.top}
						width={barSlot}
						height={barInnerH}
						fill="transparent"
						role="presentation"
						onmouseenter={() => (barHover = dayIndex)}
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
							opacity={barHover === null || barHover === dayIndex ? 1 : 0.35}
						/>
					{/each}
					<text x={cx} y={BAR_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
						{dayLabel(PROVIDER_DAYS[dayIndex]!)}
					</text>
				{/each}
			</svg>

			{#if barHover !== null}
				{@const cx = BAR_PAD.left + barSlot * (barHover + 0.5)}
				<div
					class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
					style:left="{Math.min(Math.max(cx, 78), barWidth - 78)}px"
				>
					<div class="mb-1 text-[10.5px] text-zinc-500">{dayLabel(PROVIDER_DAYS[barHover]!)}</div>
					{#each stacks[barHover]! as segment (segment.series.id)}
						<div class="flex items-center gap-2 text-[11.5px] whitespace-nowrap">
							<span class="size-[7px] flex-none rounded-full" style:background={segment.series.color}></span>
							<span class="flex-1 text-zinc-500">{segment.series.label}</span>
							<span class="text-zinc-200 tabular-nums">{segment.value.toLocaleString()}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</ChartCard>

	<!-- latency percentiles -->
	<ChartCard title="Latency percentiles" hint="Milliseconds, daily. Lighter is further out.">
		<div bind:clientWidth={latWidth}>
			<svg width={latWidth} height={LAT_H} role="img" aria-label="Latency percentiles over the last 14 days">
				{#each [0, 0.5, 1] as tick (tick)}
					{@const y = LAT_PAD.top + latInnerH * tick}
					<line x1={LAT_PAD.left} y1={y} x2={latWidth - LAT_PAD.right} y2={y} stroke={GRID} stroke-width="1" />
					<text x={LAT_PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill={AXIS_INK} class="tabular-nums">
						{Math.round(latMax * (1 - tick))}
					</text>
				{/each}

				{#each latPaths as series (series.key)}
					<path d={series.d} fill="none" stroke={series.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
					<!-- Direct labels: identity never rests on colour alone -->
					<text x={latWidth - LAT_PAD.right + 6} y={series.endY + 3.5} font-size="10.5" fill={series.color}>
						{series.label}
					</text>
				{/each}

				{#each DAILY as day, i (day.date)}
					{#if showTick(i, 4, DAILY.length)}
						<text x={latX(i)} y={LAT_H - 6} text-anchor="middle" font-size="10" fill={AXIS_INK}>
							{dayLabel(day.date)}
						</text>
					{/if}
				{/each}
			</svg>
		</div>
	</ChartCard>
</div>

<!-- top models -->
<ChartCard title="Top models" hint="By request volume over 14 days. Bar length is the value — one hue throughout.">
	<div class="flex flex-col gap-2.5">
		{#each TOP_MODELS as model (model.model)}
			<div class="grid grid-cols-[minmax(140px,1.1fr)_minmax(0,3fr)_84px_74px] items-center gap-3">
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
				<span class="text-right text-[12.5px] text-zinc-300 tabular-nums">{model.requests.toLocaleString()}</span>
				<span class="text-right text-[12.5px] text-zinc-600 tabular-nums">${model.spend.toFixed(2)}</span>
			</div>
		{/each}
	</div>
</ChartCard>
