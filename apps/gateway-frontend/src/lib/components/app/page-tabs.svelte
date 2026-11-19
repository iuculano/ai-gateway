<script lang="ts">
import type { Component, Snippet } from 'svelte';

/**
 * Section tabs under a page header, one route each so a tab can be linked to.
 * Anything passed as children sits at the right end of the row.
 */
let {
  label,
  tabs,
  current,
  children,
}: {
  /** Names the tab row for screen readers. */
  label: string;
  tabs: { id: string; label: string; href: string; icon: Component<{ class?: string }> }[];
  current: string;
  children?: Snippet;
} = $props();
</script>

<div class="mb-4 flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-line">
	<nav class="-mb-px flex gap-1" aria-label={label}>
		{#each tabs as tab (tab.id)}
			{@const on = tab.id === current}
			<a
				href={tab.href}
				aria-current={on ? 'page' : undefined}
				class="flex items-center gap-2 border-b-2 px-3 pt-1 pb-2.5 text-[13.5px] font-medium transition-colors {on
					? 'border-emerald-500 text-zinc-50'
					: 'border-transparent text-zinc-500 hover:text-zinc-300'}"
			>
				<tab.icon class="size-4" />
				{tab.label}
			</a>
		{/each}
	</nav>
	{#if children}
		<div class="ml-auto flex items-center gap-2.5 pb-2">
			{@render children()}
		</div>
	{/if}
</div>
