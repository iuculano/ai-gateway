<script lang="ts">
import type { Snippet } from 'svelte';

// One labelled control inside a SettingsSection. The control column has a fixed
// width, because a section mixes switches, selects and number boxes, and sized
// to their contents they would step down the right edge of the card and not
// line up.

interface Props {
  label: string;
  description?: string;

  /**
   * The `ai-*` request header that overrides this default, if there is one. It
   * is shown beside the label, because nothing else on the page would say which
   * of the two wins.
   */
  header?: string;

  /**
   * Why this control does nothing yet, such as 'Not wired'. A setting that
   * nothing reads has to say so on its face.
   */
  pending?: string;
  children: Snippet;
}

let { label, description, header, pending, children }: Props = $props();
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
