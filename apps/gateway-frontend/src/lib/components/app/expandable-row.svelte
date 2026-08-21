<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * A clickable table row that opens a detail panel underneath.
 *
 * Shared so the three tables cannot disagree on row rhythm again - they were
 * py-3/gap-3.5 on keys and py-[11px]/gap-3 on the other two, with the expanded
 * panel indented 54px on one and 58px on the others.
 *
 * The height is FIXED rather than padding-driven. Padding plus content meant a
 * row was as tall as whatever it happened to hold - 40px on logs and audit,
 * 50px anywhere with an h-7 action button - so one shared component produced two
 * row rhythms depending on the page. min-h-10 with slim padding puts every row
 * at 40px and still clears a 28px button.
 *
 * `cols` must be the same value handed to the TableCard above it, so the
 * header and the rows stay in one grid.
 */
let {
  cols,
  expanded,
  ontoggle,
  cells,
  details,
}: {
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
  /** The row's own cells, in column order after the chevron. */
  cells: Snippet;
  /** The panel revealed underneath. */
  details: Snippet;
} = $props();
</script>

<div class="border-b border-hairline last:border-b-0">
	<div
		class="grid min-h-10 cursor-pointer items-center gap-3 px-[18px] py-1 transition-colors duration-100 hover:bg-surface-3 {expanded
			? 'bg-surface-3'
			: ''}"
		style:grid-template-columns={cols}
		onclick={ontoggle}
		onkeydown={(event) => event.key === 'Enter' && ontoggle()}
		role="button"
		tabindex="0"
		aria-expanded={expanded}
	>
		<span
			class="flex items-center justify-center text-zinc-600 transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
		>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</span>
		{@render cells()}
	</div>

	{#if expanded}
		<div class="flex animate-fade-in flex-col gap-3.5 bg-surface-0 pt-[18px] pr-5 pb-5 pl-[58px]">
			{@render details()}
		</div>
	{/if}
</div>
