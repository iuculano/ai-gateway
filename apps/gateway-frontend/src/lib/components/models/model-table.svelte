<script lang="ts">
import type { CatalogModel } from '$lib/api/types';
import { fmtContext, fmtPricePerMillion } from '$lib/data/format';

// Renders what it is given. The page owns filtering, so this cannot disagree
// with the row above it about which models matched.
let { models }: { models: CatalogModel[] } = $props();

// Not the shared TableCard grid: this list sits inside an already-indented
// panel, so it runs at the tighter rhythm the detail panels use rather than the
// 40px rows of the page-level table.
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

/**
 * Delisted outranks the upstream status.
 *
 * They are separate facts - `status` is what the provider says about a model,
 * `delisted_at` is that the model stopped appearing at all - but a row that has
 * left the catalogue is the more urgent of the two, and there is one column.
 */
function toneFor(model: CatalogModel) {
  return model.delisted_at !== null ? STATUS_TONES.delisted : STATUS_TONES[model.status];
}

// Cheapest first, and unpriced last rather than first - a null sorted as zero
// would put every image model above the models people actually price-shop.
// Compared branch by branch rather than by subtracting infinities, which is NaN
// for two unpriced rows and leaves their order to the sort's discretion.
const visible = $derived(
  [...models].sort((a, b) => {
    if (a.cost_input === b.cost_input) return 0;
    if (a.cost_input === null) return 1;
    if (b.cost_input === null) return -1;
    return a.cost_input - b.cost_input;
  }),
);

/** The capability flags a row carries, as short labels. */
function capabilities(model: CatalogModel): string[] {
  const flags: string[] = [];
  if (model.tool_call) flags.push('Tools');
  if (model.reasoning) flags.push('Reasoning');
  if (model.attachment) flags.push('Vision');
  if (model.structured_output) flags.push('JSON');
  return flags;
}

/** An unknown price is styled apart from a real one, never just formatted. */
const priceClass = (value: number | null) => (value === null ? 'text-zinc-600 italic' : 'text-zinc-300');
</script>

<!--
	Capped and scrolled rather than paged. Azure alone publishes 84 models, which
	is ~3000px of row inside a panel that is itself inside a table row.

	Paging would fight the search: the filter is client-side over an already
	loaded list, so a page boundary would either have to be recomputed per
	keystroke or - worse - applied before the filter, which hides matches on
	later pages. Everything is in memory already, so scrolling costs nothing and
	keeps every match reachable. At 183 rows total there is nothing to virtualize.

	The header lives INSIDE the scroll container and sticks. Outside it, the
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
			{@const tone = toneFor(model)}
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
					{#if model.source === 'custom'}
						<!-- On the name rather than in Status: which rows are yours is a fact
						     about identity, and it is what decides whether a row is editable. -->
						<span
							class="flex-none rounded-[5px] bg-violet-500/12 px-1.5 py-px text-[10px] font-medium text-violet-400"
						>
							Custom
						</span>
					{/if}
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
