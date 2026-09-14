<script lang="ts">
/**
 * One figure in the strip above a table.
 *
 * The three pages had three different cards - 20px / 25px / 27px values, label
 * above on two and below on a third, and three paddings. This is the settled
 * shape: label on top, figure beneath, optional hint alongside it.
 *
 * Deliberately closed to extra content. StatGrid stretches every card in a row
 * to the tallest, so one card carrying something extra silently makes every
 * card on THAT page taller than the same card on every other page - which is
 * exactly the drift this component exists to remove. The keys page had a bar
 * strip under its figure and cost all four of its cards 14px. Anything that
 * varies the height belongs beside the grid, not inside a card.
 */
let {
  label,
  value,
  hint,
  accent,
  comparison,
  compact = false,
}: {
  label: string;
  /** Pre-formatted. Callers own their own units and precision. */
  value: string | number;
  /** Secondary figure sat next to the value, e.g. '632 failed'. */
  hint?: string;
  /** Optional swatch colour, for cards that carry a status meaning. */
  accent?: string;
  comparison?: { text: string; color: string; title: string };
  /** Inline summary for dense dashboards; other pages retain the stacked card. */
  compact?: boolean;
} = $props();
</script>

{#if compact}
<!-- Compact chart toolbars are 32px controls + 16px padding + a 1px divider. -->
<div class="flex h-[49px] min-w-0 items-center gap-3 rounded-[11px] border border-track bg-surface-1 px-4 py-2">
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
