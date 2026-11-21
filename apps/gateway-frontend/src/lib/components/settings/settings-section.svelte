<script lang="ts">
import type { Snippet } from 'svelte';

// A titled group of setting rows. It is not a Panel, whose header bar is one
// uppercase caption with no room for the sentence each of these groups needs
// to say what it governs. The border, radius and surface are the same, so the
// two still read as one family.

interface Props {
  title: string;
  description?: string;
  children: Snippet;
}

let { title, description, children }: Props = $props();
</script>

<section class="overflow-hidden rounded-[9px] border border-line bg-surface-2">
	<div class="border-b border-line px-4 py-3">
		<h2 class="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-100">{title}</h2>
		{#if description}
			<p class="mt-1 max-w-[78ch] text-[12.5px] leading-[1.5] text-zinc-500">{description}</p>
		{/if}
	</div>

	<!-- Divided and not bordered row by row, because the last row must not carry
	     a border and the section's own bottom edge already draws it. -->
	<div class="divide-y divide-hairline">
		{@render children()}
	</div>
</section>
