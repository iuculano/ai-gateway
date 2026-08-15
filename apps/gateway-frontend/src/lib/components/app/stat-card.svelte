<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * One figure in the strip above a table.
 *
 * The three pages had three different cards - 20px / 25px / 27px values, label
 * above on two and below on a third, and three paddings. This is the settled
 * shape: label on top, figure beneath, optional hint alongside it.
 */
let {
  label,
  value,
  hint,
  accent,
  children,
}: {
  label: string;
  /** Pre-formatted. Callers own their own units and precision. */
  value: string | number;
  /** Secondary figure sat next to the value, e.g. '632 failed'. */
  hint?: string;
  /** Optional swatch colour, for cards that carry a status meaning. */
  accent?: string;
  /** Anything that belongs under the figure, like the keys page's bar strip. */
  children?: Snippet;
} = $props();
</script>

<div class="rounded-[11px] border border-track bg-surface-2 px-4 py-[15px]">
	<div class="flex items-center gap-[7px]">
		{#if accent}
			<span class="size-[7px] flex-none rounded-full" style:background={accent}></span>
		{/if}
		<span class="text-xs text-zinc-500">{label}</span>
	</div>
	<div class="mt-2 flex items-end gap-2">
		<span class="text-[25px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
		{#if hint}
			<span class="mb-px text-[13px] text-zinc-600">{hint}</span>
		{/if}
	</div>
	{@render children?.()}
</div>
