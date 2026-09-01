<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * The title block every list page opens with.
 *
 * Owns the spacing and type scale so the three pages cannot drift apart again -
 * they previously disagreed on the bottom margin alone (mb-6 vs mb-[22px]).
 */
let {
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  /** Right-aligned controls. Use ToolbarButton so the heights match. */
  actions?: Snippet;
} = $props();
</script>

<div class="mb-[22px] flex items-end gap-5">
	<div>
		<h1 class="mb-[5px] text-[23px] font-semibold tracking-[-0.02em]">{title}</h1>
		{#if description}
			<p class="text-[13.5px] text-zinc-500">{description}</p>
		{/if}
	</div>
	{#if actions}
		<div class="ml-auto flex items-center gap-2.5">
			{@render actions()}
		</div>
	{/if}
</div>
