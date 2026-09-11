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
  /** Adds a button to copy the full value. */
  copyable?: boolean;
}
</script>

<script lang="ts">
import { copyToClipboard } from '$lib/clipboard';
let { items, cols = 4 }: { items: DetailItem[]; cols?: 2 | 3 | 4 } = $props();

// Spelled out rather than interpolated - Tailwind only compiles classes it can
// find in source.
const COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' } as const;
</script>

<div class="grid gap-px overflow-hidden rounded-[9px] border border-line bg-line {COLS[cols]}">
	{#each items as item (item.label)}
		<div class="bg-surface-2 px-[13px] py-2.5">
			<div class="mb-[3px] text-[10.5px] text-zinc-600">{item.label}</div>
			<div class="flex min-w-0 items-center gap-2">
				<div
					class="min-w-0 flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap {item.mono === false
						? ''
						: 'font-mono'} {item.tone ? 'font-medium' : 'text-zinc-300'}"
					style:color={item.tone}
					title={item.title}
				>
					{item.value}
				</div>
				{#if item.copyable}
					<button
						type="button"
						class="shrink-0 rounded text-zinc-500 hover:text-zinc-200"
						aria-label="Copy {item.label}"
						title="Copy {item.label}"
						onclick={() => void copyToClipboard(item.value, `${item.label} copied`)}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" /><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" stroke="currentColor" stroke-width="1.3" /></svg>
					</button>
				{/if}
			</div>
		</div>
	{/each}
</div>
