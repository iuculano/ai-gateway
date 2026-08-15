<script module lang="ts">
/**
 * The label/value grid at the top of an expanded row.
 *
 * All three rows built this by hand with the same hairline trick (gap-px over a
 * bg-line parent), just with different column counts and cell markup.
 */
export interface DetailItem {
  label: string;
  value: string;
  /** Ids, keys and timestamps read better monospaced. On by default. */
  mono?: boolean;
  /** Overrides the value colour, for cells that carry a status. */
  tone?: string;
  /** Native tooltip, for values that get truncated. */
  title?: string;
}
</script>

<script lang="ts">
let { items, cols = 4 }: { items: DetailItem[]; cols?: 2 | 3 | 4 } = $props();

// Spelled out rather than interpolated - Tailwind only compiles classes it can
// find in source.
const COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' } as const;
</script>

<div class="grid gap-px overflow-hidden rounded-[9px] border border-line bg-line {COLS[cols]}">
	{#each items as item (item.label)}
		<div class="bg-surface-2 px-[13px] py-2.5">
			<div class="mb-[3px] text-[10.5px] text-zinc-600">{item.label}</div>
			<div
				class="overflow-hidden text-xs text-ellipsis whitespace-nowrap {item.mono === false
					? ''
					: 'font-mono'} {item.tone ? 'font-medium' : 'text-zinc-300'}"
				style:color={item.tone}
				title={item.title}
			>
				{item.value}
			</div>
		</div>
	{/each}
</div>
