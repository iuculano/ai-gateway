<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * The strip of StatCards above a table.
 *
 * The default uses four columns, whatever the page puts in it. A per-page column count
 * would make a card on a two-stat page twice the width of one on a four-stat
 * page, which is the drift this is meant to remove - a stat card should be the
 * same object everywhere. Pages with fewer than four simply leave the tail of
 * the row empty, which is what the keys page already did.
 * Compact inline summaries use fewer columns on narrow screens to keep their labels readable.
 */
let { children, compact = false, columns = 4 }: {
  children: Snippet;
  compact?: boolean;
  /** Number of inline summaries across on wide screens. */
  columns?: 4 | 5;
} = $props();
</script>

<div class="grid {compact ? `mb-2.5 grid-cols-1 gap-2.5 sm:grid-cols-2 ${columns === 5 ? '2xl:grid-cols-5' : '2xl:grid-cols-4'}` : 'mb-5 grid-cols-4 gap-3.5'}">
	{@render children()}
</div>
