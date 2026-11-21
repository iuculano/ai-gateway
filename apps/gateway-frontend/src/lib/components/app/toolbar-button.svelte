<script lang="ts">
import type { Snippet } from 'svelte';

// The one secondary button used in page headers and table toolbars. Its height
// matches the outer height of FilterTabs, so that a toolbar row lines up.

interface Props {
  /**
   * 'primary' is the page's single call to action. Everything else is ghost.
   */
  variant?: 'ghost' | 'primary';
  disabled?: boolean;
  onclick?: (event: MouseEvent) => void;
  children: Snippet;
}

let { variant = 'ghost', disabled = false, onclick, children }: Props = $props();

const CLASSES = {
  ghost:
    'border border-line-strong bg-surface-3 text-zinc-400 hover:bg-surface-4 hover:text-zinc-200 disabled:opacity-50',
  primary:
    'bg-emerald-500 font-semibold text-[#04130d] shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_2px_10px_rgba(16,185,129,.22)] hover:bg-[#13c98d] disabled:opacity-50',
} as const;
</script>

<button
	type="button"
	class="flex h-8 items-center gap-[7px] rounded-lg px-3 text-[12.5px] tracking-[-0.01em] disabled:cursor-not-allowed {CLASSES[
		variant
	]}"
	{disabled}
	{onclick}
>
	{@render children()}
</button>
