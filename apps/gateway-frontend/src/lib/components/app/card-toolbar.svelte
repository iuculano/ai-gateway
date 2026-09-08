<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * The toolbar row at the top of a page-level card.
 *
 * TableCard and custom cards both render through this component so their
 * controls share one source of truth for wrapping, spacing, padding, and the
 * divider below the row.
 */
let { children }: { children: Snippet } = $props();
</script>

<div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-[13px]">
	{@render children()}
</div>
