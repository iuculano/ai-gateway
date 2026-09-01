<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * The strip of StatCards above a table.
 *
 * Always four columns, whatever the page puts in it. A per-page column count
 * would make a card on a two-stat page twice the width of one on a four-stat
 * page, which is the drift this is meant to remove - a stat card should be the
 * same object everywhere. Pages with fewer than four simply leave the tail of
 * the row empty, which is what the keys page already did.
 */
let { children }: { children: Snippet } = $props();
</script>

<div class="mb-5 grid grid-cols-4 gap-3.5">
	{@render children()}
</div>
