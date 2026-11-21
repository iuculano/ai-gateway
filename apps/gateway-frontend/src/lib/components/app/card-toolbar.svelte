<script lang="ts">
import type { Snippet } from 'svelte';

// The toolbar row at the top of a page-level card. TableCard and custom cards
// both render through it, so that wrapping, spacing and the divider below are
// decided in one place.
let { children }: { children: Snippet } = $props();
</script>

<div class="flex flex-wrap items-center border-b border-line gap-3 px-4 py-[13px]">
	{@render children()}
</div>
