<script lang="ts">
import type { Snippet } from 'svelte';
import CardToolbar from './card-toolbar.svelte';
import ToolbarButton from './toolbar-button.svelte';

/**
 * The bordered card every list page renders its table into: toolbar, column
 * header, and the loading / error / empty states.
 *
 * Those states were the worst of the drift - three loading labels in two
 * greys, and a retry button that was h-8 "Try again" on one page and h-[30px]
 * "Retry" on the other two.
 *
 * `cols` is applied as an inline style rather than a class. Tailwind compiles
 * the classes it can see in source, so a grid template passed in as a prop
 * would never be generated. Rows take the same value - see ExpandableRow.
 */
let {
  cols,
  columns,
  toolbar,
  loading = false,
  error = null,
  isEmpty = false,
  loadingLabel = 'Loading…',
  emptyTitle = 'Nothing to show',
  emptyHint,
  onretry,
  children,
  footer,
  showFooter = true,
}: {
  /** A CSS grid-template-columns value, e.g. '24px 1.8fr 1fr 84px'. */
  cols: string;
  columns: { label: string; align?: 'left' | 'right' }[];
  toolbar?: Snippet;
  loading?: boolean;
  error?: string | null;
  isEmpty?: boolean;
  loadingLabel?: string;
  emptyTitle?: string;
  emptyHint?: string;
  onretry?: () => void;
  children: Snippet;
  /** Pagination, when the page has more to fetch. */
  footer?: Snippet;
  /** Lets a caller keep the footer snippet but hide the bar once it is exhausted. */
  showFooter?: boolean;
} = $props();
</script>

<div class="overflow-hidden rounded-xl border border-track bg-surface-1">
	{#if toolbar}
		<CardToolbar>
			{@render toolbar()}
		</CardToolbar>
	{/if}

	<div
		class="grid gap-3 border-b border-line px-[18px] py-[9px] text-[11px] font-medium tracking-[.05em] text-zinc-600 uppercase"
		style:grid-template-columns={cols}
	>
		{#each columns as column, index (index)}
			<span class={column.align === 'right' ? 'text-right' : undefined}>{column.label}</span>
		{/each}
	</div>

	{#if loading}
		<div class="px-[18px] py-10 text-center text-[13px] text-zinc-500">{loadingLabel}</div>
	{:else if error}
		<div class="flex flex-col items-center gap-3 px-[18px] py-10 text-center">
			<span class="text-[13px] text-red-400">{error}</span>
			{#if onretry}
				<ToolbarButton onclick={onretry}>Retry</ToolbarButton>
			{/if}
		</div>
	{:else if isEmpty}
		<div class="flex flex-col items-center gap-2 px-[18px] py-10 text-center">
			<span class="text-[13px] text-zinc-500">{emptyTitle}</span>
			{#if emptyHint}
				<span class="text-[12.5px] text-zinc-600">{emptyHint}</span>
			{/if}
		</div>
	{:else}
		{@render children()}
		{#if footer && showFooter}
			<div class="border-t border-line px-[18px] py-3 text-center">
				{@render footer()}
			</div>
		{/if}
	{/if}
</div>
