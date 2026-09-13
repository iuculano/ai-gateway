<script lang="ts">
import type { SeriesPoint } from '$lib/api/analytics';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import { cumulativeSpend } from '$lib/data/chart-series';
import ChartCard from '$lib/components/app/chart-card.svelte';

let {
  points,
  loading,
  rangeLabel,
  bucketLabel,
  interval,
}: {
  interval: 'hour' | 'day';
  points: SeriesPoint[];
  loading: boolean;
  rangeLabel: string;
  bucketLabel: (bucket: string | null) => string;
} = $props();

let view = $state<'period' | 'cumulative'>('period');
const views = $derived([{ id: 'period' as const, label: interval === 'hour' ? 'Hourly' : 'Daily' }, { id: 'cumulative' as const, label: 'Cumulative' }]);
const displayed = $derived(view === 'cumulative' ? cumulativeSpend(points) : points);
const HEIGHT = 210;
const PAD = { top: 14, right: 10, bottom: 24, left: 76 };
const INPUT = '#60a5fa';
const OUTPUT = '#a78bfa';
const plotHeight = HEIGHT - PAD.top - PAD.bottom;
let width = $state(720);
let hovered = $state<number | null>(null);

const plotWidth = $derived(Math.max(1, width - PAD.left - PAD.right));
const slot = $derived(plotWidth / Math.max(1, displayed.length));
const barWidth = $derived(Math.min(32, slot * 0.65));
const maximum = $derived.by(() => {
  const peak = Math.max(0, ...displayed.map((point) => point.cost_input + point.cost_output));
  if (peak === 0) return 1;
  const step = 10 ** Math.floor(Math.log10(peak)) / 2;
  return Math.ceil(peak / step) * step;
});
const selected = $derived(hovered === null ? null : displayed[hovered]);
const x = (index: number) => PAD.left + slot * (index + 0.5);
const height = (cost: number) => (cost / maximum) * plotHeight;
const money = (cost: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  maximumFractionDigits: cost !== 0 && Math.abs(cost) < 0.01 ? 6 : 2,
}).format(cost);

// Clear the tooltip when the range changes or a new response arrives.
$effect(() => {
  void points;
  void view;
  void loading;
  hovered = null;
});
</script>

<ChartCard title="Spend over time" hint={view === 'cumulative' ? 'Running total in this window.' : 'Input and output costs.'}>
	{#snippet actions()}
        <FilterTabs tabs={views} bind:value={view} />
	{/snippet}
	<div class="relative" bind:clientWidth={width}>
        
		<div class="pointer-events-none absolute top-0 right-2 flex items-center gap-3 text-[10px] text-zinc-400">
			<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={INPUT}></span>Input</span>
			<span class="flex items-center gap-1.5"><span class="size-2 rounded-sm" style:background={OUTPUT}></span>Output</span>
		</div>
		{#if loading}
			<div class="flex h-[210px] items-center justify-center text-[12.5px] text-zinc-600">Loading spend…</div>
		{:else if displayed.length === 0}
			<div class="flex h-[210px] items-center justify-center text-[12.5px] text-zinc-600">No spend data in this window.</div>
		{:else}
			<svg {width} height={HEIGHT} role="img" aria-label="{view === 'cumulative' ? 'Cumulative' : 'Per-period'} input and output spend over {rangeLabel.toLowerCase()}">
				{#each [0, 0.25, 0.5, 0.75, 1] as tick (tick)}
					{@const y = PAD.top + plotHeight * (1 - tick)}
					<line x1={PAD.left} y1={y} x2={width - PAD.right} y2={y} stroke="#1f1f23" />
					<text x={PAD.left - 8} y={y + 3.5} text-anchor="end" font-size="10" fill="#52525b" class="tabular-nums">{money(maximum * tick)}</text>
				{/each}
				{#each displayed as point, index (point.bucket)}
					{@const inputHeight = height(point.cost_input)}
					{@const outputHeight = height(point.cost_output)}
					<g opacity={hovered === null || hovered === index ? 1 : 0.4}>
						<rect x={x(index) - barWidth / 2} y={PAD.top + plotHeight - inputHeight} width={barWidth} height={inputHeight} fill={INPUT} />
						<rect x={x(index) - barWidth / 2} y={PAD.top + plotHeight - inputHeight - outputHeight} width={barWidth} height={outputHeight} fill={OUTPUT} />
					</g>
					{@const every = Math.max(1, Math.ceil(displayed.length / Math.max(2, Math.floor(plotWidth / 85))))}
					{#if index === displayed.length - 1 || (index % every === 0 && displayed.length - 1 - index >= every - 1)}
						<text x={x(index)} y={HEIGHT - 6} text-anchor="middle" font-size="10" fill="#52525b">{bucketLabel(point.bucket)}</text>
					{/if}
				{/each}
			</svg>
			{#each displayed as point, index (point.bucket)}
				<button
					type="button"
					class="absolute rounded-sm focus-visible:outline-2 focus-visible:outline-sky-400"
					style:left="{PAD.left + slot * index}px"
					style:top="{PAD.top}px"
					style:width="{slot}px"
					style:height="{plotHeight}px"
					aria-label="{bucketLabel(point.bucket)}: {money(point.cost_total)} total, {money(point.cost_input)} input, {money(point.cost_output)} output"
					onmouseenter={() => (hovered = index)}
					onmouseleave={() => (hovered = null)}
					onfocus={() => (hovered = index)}
					onblur={() => (hovered = null)}
					onclick={() => (hovered = index)}
					onkeydown={(event) => { if (event.key === 'Escape') hovered = null; }}
				></button>
			{/each}
			{#if selected && hovered !== null}
				<div
					class="pointer-events-none absolute top-1 z-10 w-48 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-5 px-3 py-2 text-[11.5px] shadow-lg"
					style:left="{Math.min(Math.max(x(hovered), 96), Math.max(96, width - 96))}px"
				>
					<div class="mb-1 text-zinc-500">{view === 'cumulative' ? 'Through ' : ''}{bucketLabel(selected.bucket)}</div>
					<div class="flex justify-between gap-3 text-blue-400"><span>Input</span><span class="tabular-nums">{money(selected.cost_input)}</span></div>
					<div class="flex justify-between gap-3 text-violet-400"><span>Output</span><span class="tabular-nums">{money(selected.cost_output)}</span></div>
					<div class="mt-1 flex justify-between gap-3 border-t border-line pt-1 font-medium text-zinc-200"><span>Total</span><span class="tabular-nums">{money(selected.cost_total)}</span></div>
				</div>
			{/if}
		{/if}
	</div>
</ChartCard>
