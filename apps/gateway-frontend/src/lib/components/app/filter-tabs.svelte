<script lang="ts" generics="T extends string">
/**
 * The single filter control for every list page.
 *
 * These were three different things: a segmented control at 26px on keys,
 * coloured pills at 30px on audit, and a segmented control at 12px text on
 * logs. One segmented control now.
 *
 * The optional dot is what let audit's categories fold in without losing their
 * colour coding - the shape is shared, the meaning survives.
 *
 * Outer height is 32px (26 + padding + border), matching ToolbarButton so a
 * toolbar row aligns.
 */
let {
  tabs,
  value = $bindable(),
}: {
  tabs: { id: T; label: string; color?: string }[];
  value: T;
} = $props();
</script>

<div class="flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-surface-3 p-0.5">
	{#each tabs as tab (tab.id)}
		{@const on = value === tab.id}
		<button
			type="button"
			class="flex h-[26px] items-center gap-[7px] rounded-md px-[13px] text-[12.5px] font-medium {on
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
