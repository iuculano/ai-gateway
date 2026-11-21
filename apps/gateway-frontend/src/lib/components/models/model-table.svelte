<script lang="ts">
import type { CatalogModel } from '#lib/api/types.ts';
import { byInputPrice, capabilities, modelStatus } from '#lib/data/catalog.ts';
import { fmtContext, fmtPricePerMillion } from '#lib/data/format.ts';

// Renders the models it is given. The page owns filtering, so this cannot
// disagree with the row above it about which models matched.
let { models }: { models: CatalogModel[] } = $props();

// Its own grid and not the shared TableCard's. This list sits inside a panel
// that is already indented, so it runs at the tighter rhythm of the detail
// panels and not at the 40px rows of a page-level table.
const COLS = '1.9fr 76px 86px 86px 86px 1.2fr 104px';

const COLUMNS = [
  { label: 'Model' },
  { label: 'Context', align: 'right' as const },
  { label: 'Input', align: 'right' as const },
  { label: 'Cached', align: 'right' as const },
  { label: 'Output', align: 'right' as const },
  { label: 'Capabilities' },
  { label: 'Status' },
];

const STATUS_TONES = {
  available: { label: 'Available', color: '#71717a' },
  beta: { label: 'Beta', color: '#60a5fa' },
  deprecated: { label: 'Deprecated', color: '#f59e0b' },
  delisted: { label: 'Delisted', color: '#f87171' },
} as const;

const visible = $derived(byInputPrice(models));

/**
 * An unknown price is styled apart from a real one, and not only formatted.
 */
function priceClass(value: number | null): string {
  return value === null ? 'text-zinc-600 italic' : 'text-zinc-300';
}
</script>

<!--
	Capped and scrolled, and not paged. One provider alone can publish over
	eighty models, which is thousands of pixels of rows inside a panel that is
	itself inside a table row.

	Paging would fight the search. The filter runs in the browser over a list
	that is already loaded, so a page boundary would have to be worked out again
	on every keystroke, or be applied before the filter and hide matches on later
	pages. Everything is in memory already, so scrolling costs nothing and keeps
	every match reachable.

	The header lives inside the scroll container and sticks. Outside it, the
	scrollbar would narrow the rows and leave the columns misaligned by its width.
-->
<div class="max-h-[420px] overflow-y-auto">
	<div
		class="sticky top-0 z-10 grid gap-3 border-b border-line bg-surface-2 px-3.5 py-2 text-[10.5px] font-medium tracking-[.05em] text-zinc-600 uppercase"
		style:grid-template-columns={COLS}
	>
		{#each COLUMNS as column, index (index)}
			<span class={column.align === 'right' ? 'text-right' : undefined}>{column.label}</span>
		{/each}
	</div>

	{#if visible.length === 0}
		<div class="px-3.5 py-7 text-center text-[12.5px] text-zinc-600">No models for this provider.</div>
	{:else}
		{#each visible as model (model.id)}
			{@const tone = STATUS_TONES[modelStatus(model)]}
			<div
				class="grid min-h-9 items-center gap-3 border-b border-hairline px-3.5 py-1.5 last:border-b-0"
				style:grid-template-columns={COLS}
			>
				<span class="inline-flex min-w-0 items-center gap-2">
					<span
						class="overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-200"
						title={model.display_name ?? undefined}
					>
						{model.name}
					</span>
				</span>

				<span class="text-right text-[12.5px] text-zinc-400 tabular-nums">{fmtContext(model.context_limit)}</span>
				<span class="text-right text-[12.5px] tabular-nums {priceClass(model.cost_input)}">
					{fmtPricePerMillion(model.cost_input)}
				</span>
				<span class="text-right text-[12.5px] tabular-nums {priceClass(model.cost_cache_read)}">
					{fmtPricePerMillion(model.cost_cache_read)}
				</span>
				<span class="text-right text-[12.5px] tabular-nums {priceClass(model.cost_output)}">
					{fmtPricePerMillion(model.cost_output)}
				</span>

				<span class="flex flex-wrap items-center gap-1">
					{#each capabilities(model) as flag (flag)}
						<span class="rounded-[5px] bg-surface-4 px-1.5 py-px text-[10.5px] text-zinc-400">{flag}</span>
					{:else}
						<span class="text-[12.5px] text-zinc-700">—</span>
					{/each}
				</span>

				<span class="inline-flex items-center gap-1.5 text-[11.5px] font-medium" style:color={tone.color}>
					<span class="size-1.5 flex-none rounded-full" style:background={tone.color}></span>
					{tone.label}
				</span>
			</div>
		{/each}
	{/if}
</div>
