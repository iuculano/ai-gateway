<script lang="ts">
import type { Snippet } from 'svelte';

// The strip of StatCards above a table. It is four columns whatever the page
// puts in it, because a column count per page would make a card on a two-stat
// page twice as wide as one on a four-stat page. Compact summaries use fewer
// columns on narrow screens, to keep their labels readable.

interface Props {
  children: Snippet;
  compact?: boolean;

  /**
   * How many inline summaries sit across on wide screens.
   */
  columns?: 4 | 5 | 6;
}

let { children, compact = false, columns = 4 }: Props = $props();

// Spelled out so that Tailwind sees each class.
const WIDE_COLUMNS = { 4: '2xl:grid-cols-4', 5: '2xl:grid-cols-5', 6: '2xl:grid-cols-6' };
</script>

<div class="grid {compact ? `mb-[var(--analytics-summary-gap,10px)] grid-cols-1 gap-[var(--analytics-gap,10px)] sm:grid-cols-2 ${WIDE_COLUMNS[columns]}` : 'mb-5 grid-cols-4 gap-3.5'}">
	{@render children()}
</div>
