<script lang="ts">
import type { Snippet } from 'svelte';
import CardToolbar from './card-toolbar.svelte';

// A page-level card for a chart. It has the same shell as TableCard, so that a
// dashboard of charts and a table page read as the same surface. Panel is the
// nested equivalent, for boxes inside an expanded row.

interface Props {
  title: string;

  /**
   * A description beside the title. Its full text stays in the tooltip.
   */
  hint?: string;

  /**
   * Right-aligned controls, such as a legend or a range toggle.
   */
  actions?: Snippet;
  children: Snippet;
}

let { title, hint, actions, children }: Props = $props();
</script>

<div class="overflow-hidden rounded-xl border border-track bg-surface-1">
	<CardToolbar>
		<div class="flex h-8 min-w-0 flex-1 items-center gap-2.5">
			<h2 class="shrink-0 text-[13px] font-medium text-zinc-200">{title}</h2>
			{#if hint}
				<p class="truncate text-[12.5px] text-zinc-500" title={hint}>{hint}</p>
			{/if}
		</div>
		{#if actions}
			<div class="ml-auto flex min-h-8 flex-wrap items-center gap-3">{@render actions()}</div>
		{/if}
	</CardToolbar>
	<div class="px-4 py-[var(--analytics-body-padding,8px)]">
		{@render children()}
	</div>
</div>
