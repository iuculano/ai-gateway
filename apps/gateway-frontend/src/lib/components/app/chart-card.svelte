<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * A page-level card for a chart.
 *
 * Same shell as TableCard - rounded-xl on border-track over surface-1 - so a
 * dashboard of charts and a table page read as the same surface. Panel is the
 * nested equivalent, for boxes inside an expanded row.
 */
let {
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  /** Sits under the title. Say what the number actually measures. */
  hint?: string;
  /** Right-aligned controls, e.g. a legend or a range toggle. */
  actions?: Snippet;
  children: Snippet;
} = $props();
</script>

<div class="overflow-hidden rounded-xl border border-track bg-surface-1">
	<div class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-[18px] py-[13px]">
		<div>
			<h2 class="text-[13.5px] font-medium tracking-[-0.01em] text-zinc-200">{title}</h2>
			{#if hint}
				<p class="mt-[3px] text-[11.5px] text-zinc-600">{hint}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex flex-wrap items-center gap-3">{@render actions()}</div>
		{/if}
	</div>
	<div class="px-[18px] py-4">
		{@render children()}
	</div>
</div>
