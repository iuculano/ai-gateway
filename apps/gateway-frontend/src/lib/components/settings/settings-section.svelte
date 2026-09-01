<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * A titled group of setting rows.
 *
 * Deliberately not Panel. That one is the box inside an expanded table row, and
 * its header bar is a single uppercase caption with no room for the sentence of
 * context each of these groups needs to explain what it governs. Same border,
 * radius and surface, so the two still read as one family.
 */
let {
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: Snippet;
} = $props();
</script>

<section class="overflow-hidden rounded-[9px] border border-line bg-surface-2">
	<div class="border-b border-line px-4 py-3">
		<h2 class="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-100">{title}</h2>
		{#if description}
			<p class="mt-1 max-w-[78ch] text-[12.5px] leading-[1.5] text-zinc-500">{description}</p>
		{/if}
	</div>

	<!-- divide-y rather than a border on each row: the last row must not carry
	     one, and the section's own bottom edge already draws it. -->
	<div class="divide-y divide-hairline">
		{@render children()}
	</div>
</section>
