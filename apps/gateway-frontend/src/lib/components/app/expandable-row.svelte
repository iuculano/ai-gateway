<script lang="ts">
import type { Snippet } from 'svelte';

// A clickable table row that opens a detail panel underneath, shared so that
// every table has the same row rhythm.
//
// The height is fixed and not driven by padding. With padding a row is as tall
// as whatever it holds, so one with an action button comes out taller than one
// without. A minimum of 40px with slim padding puts every row at one height and
// still clears a 28px button.

interface Props {
  /**
   * The same grid template that was handed to the TableCard above, so that the
   * header and the rows stay in one grid.
   */
  cols: string;
  expanded: boolean;
  ontoggle: () => void;

  /**
   * The row's own cells, in column order after the chevron.
   */
  cells: Snippet;

  /**
   * The panel revealed underneath.
   */
  details: Snippet;
}

let { cols, expanded, ontoggle, cells, details }: Props = $props();
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
