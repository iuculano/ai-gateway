<script lang="ts">
// One figure in the strip above a table, with the label on top, the figure
// beneath and an optional hint beside it.
//
// It takes no extra content on purpose. StatGrid stretches every card in a row
// to the tallest, so one card carrying something extra would make every card on
// that page taller than the same card elsewhere. Anything that varies the
// height belongs beside the grid.

interface Props {
  label: string;

  /**
   * Already formatted. Callers own their units and precision.
   */
  value: string | number;

  /**
   * A secondary figure beside the value, such as '632 failed'.
   */
  hint?: string;

  /**
   * A swatch colour, for cards that carry a status.
   */
  accent?: string;
  comparison?: { text: string; color: string; title: string };

  /**
   * An inline summary for dense dashboards. Other pages keep the stacked card.
   */
  compact?: boolean;
}

let { label, value, hint, accent, comparison, compact = false }: Props = $props();
</script>

{#if compact}
<!-- The height of a standard card header, which is a 32px control, 26px of
     padding and a 1px divider. -->
<div class="flex h-[59px] min-w-0 items-center gap-3 rounded-[11px] border border-track bg-surface-1 px-4 py-[13px]">
    <span class="flex shrink-0 items-center gap-[7px] text-[13px] font-medium text-zinc-200">
        {#if accent}<span class="size-[7px] flex-none rounded-full" style:background={accent}></span>{/if}
        {label}
    </span>
    <span class="ml-auto shrink-0 font-mono text-[14px] font-medium text-zinc-100 tabular-nums">{value}</span>
    {#if hint}<span class="min-w-0 truncate text-[11px] text-zinc-400" title={hint}>{hint}</span>{/if}
    {#if comparison}
        <span class="shrink-0 border-l border-line-strong pl-3 text-xs font-medium tabular-nums" style:color={comparison.color} title={comparison.title}>{comparison.text}</span>
    {/if}
</div>
{:else}
<div class="rounded-[11px] border border-track bg-surface-2 px-4 py-[15px]">
	<div class="flex items-center gap-[7px]">
		{#if accent}
			<span class="size-[7px] flex-none rounded-full" style:background={accent}></span>
		{/if}
		<span class="text-xs text-zinc-500">{label}</span>
		{#if comparison}
			<span class="ml-auto shrink-0 text-xs font-medium tabular-nums" style:color={comparison.color} title={comparison.title}>
				{comparison.text}
			</span>
		{/if}
	</div>
	<div class="mt-2 flex items-end gap-2">
		<span class="text-[25px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
		{#if hint}
			<span class="mb-px text-[13px] text-zinc-600">{hint}</span>
		{/if}
	</div>
</div>
{/if}
