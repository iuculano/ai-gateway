<script lang="ts" generics="T extends string">
// The one filter control for every list page, a segmented control. A segment
// can carry a coloured dot, which is how the audit log's categories keep their
// colour coding. The outer height is 32px, the same as ToolbarButton, so that a
// toolbar row lines up.

interface Props {
  tabs: { id: T; label: string; color?: string }[];
  value: T;

  /**
   * Gives every segment the same 72px width, for filters that must align
   * across pages.
   */
  equalWidth?: boolean;

  /**
   * Stretches the control to its container, with the segments sharing the
   * width equally.
   */
  fill?: boolean;
}

let { tabs, value = $bindable(), equalWidth = false, fill = false }: Props = $props();
</script>

<div class="flex flex-wrap gap-0.5 {fill ? 'w-full' : ''} rounded-lg border border-line-strong bg-surface-3 p-0.5">
	{#each tabs as tab (tab.id)}
		{@const on = value === tab.id}
		<button
			type="button"
			class="flex h-[26px] items-center gap-[7px] rounded-md text-[12.5px] font-medium {equalWidth
				? 'w-[72px] justify-center px-2'
				: fill
					? 'flex-1 justify-center px-[13px]'
					: 'px-[13px]'} {on
				? 'bg-seg text-zinc-50 shadow-[0_1px_2px_rgba(0,0,0,.3)]'
				: 'text-zinc-500 hover:text-zinc-300'}"
			onclick={() => (value = tab.id)}
		>
			{#if tab.color}
				<span class="size-[7px] flex-none rounded-full" style:background={tab.color}></span>
			{/if}
			{tab.label}
		</button>
	{/each}
</div>
