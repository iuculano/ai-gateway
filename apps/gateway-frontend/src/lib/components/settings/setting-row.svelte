<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * One labelled control inside a SettingsSection.
 *
 * The control column is a fixed width rather than shrink-to-fit, because a
 * section mixes switches, selects and number boxes - sized to their contents
 * they staircase down the right edge of the card instead of lining up.
 */
let {
  label,
  description,
  header,
  pending,
  children,
}: {
  label: string;
  description?: string;
  /**
   * The `ai-*` request header that overrides this default, if any.
   *
   * Rendered beside the label because that relationship is the entire design of
   * this page: these are organization defaults for knobs that exist only
   * per-request today, and nothing else on screen would tell a reader which of
   * the two wins.
   */
  header?: string;
  /**
   * Why this control does nothing yet - 'Needs enforcement', 'Phase 3'.
   *
   * A setting nothing reads has to say so on its face. The battle plan's
   * non-goals end with "accepting security settings that are not enforced", and
   * a page full of unwired toggles is the largest available version of that
   * mistake. Every row here carries one until its backend lands.
   */
  pending?: string;
  /** The control itself. */
  children: Snippet;
} = $props();
</script>

<div class="flex items-start gap-6 px-4 py-[13px]">
	<div class="min-w-0 flex-1">
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-[13px] font-medium text-zinc-200">{label}</span>
			{#if header}
				<code
					class="rounded-[5px] border border-line-strong bg-surface-4 px-1.5 py-px font-mono text-[10.5px] text-zinc-500"
				>
					{header}
				</code>
			{/if}
			{#if pending}
				<span class="rounded-[5px] bg-amber-500/12 px-1.5 py-px text-[10.5px] font-medium text-amber-500">
					{pending}
				</span>
			{/if}
		</div>
		{#if description}
			<p class="mt-[5px] max-w-[64ch] text-[12.5px] leading-[1.55] text-zinc-500">{description}</p>
		{/if}
	</div>

	<div class="flex w-[228px] flex-none items-center justify-end gap-2">
		{@render children()}
	</div>
</div>
