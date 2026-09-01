<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * A bordered sub-section inside an expanded row - the limits and scopes blocks
 * on keys, the diff/metadata block on audit, the request and response bodies on
 * logs. All six were the same box rebuilt by hand.
 */
let {
  title,
  header,
  actions,
  children,
}: {
  /** Rendered as an uppercase caption in the header bar. Omit for a bare box. */
  title?: string;
  /** Replaces the caption when the left of the bar needs a control instead. */
  header?: Snippet;
  /** Right-aligned controls in the header bar, e.g. a copy button. */
  actions?: Snippet;
  children: Snippet;
} = $props();
</script>

<!-- A flex column so a panel that has been stretched by its grid row can hand
     the leftover height to a child that asks for it with grow. Children stack
     exactly as they did under block layout when nothing asks. -->
<div class="flex flex-col overflow-hidden rounded-[9px] border border-line bg-surface-2">
	{#if title || header || actions}
		<div class="flex min-h-[42px] items-center justify-between gap-3 border-b border-line py-2 pr-2.5 pl-3">
			{#if header}
				{@render header()}
			{:else}
				<span class="text-[11px] font-medium tracking-[.05em] text-zinc-600 uppercase">{title}</span>
			{/if}
			{#if actions}
				<div class="flex items-center gap-2">{@render actions()}</div>
			{/if}
		</div>
	{/if}
	{@render children()}
</div>
