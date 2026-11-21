<script lang="ts">
import { FIELD_BASE } from '#lib/components/app/field.ts';
import { Input } from '#lib/components/ui/input/index.ts';
import type { Pair } from '#lib/data/pairs.ts';

// The key and value editor behind a webhook's filter and its tags. Both are
// string maps with no fixed set of keys, so this is a repeated pair of text
// boxes and not a picker.

interface Props {
  pairs: Pair[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  disabled?: boolean;
}

let {
  pairs = $bindable(),
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add pair',
  disabled = false,
}: Props = $props();

const FIELD_CLASS = `h-9 px-[11px] font-mono text-[12.5px] ${FIELD_BASE}`;
</script>

<div class="flex flex-col gap-2">
	{#each pairs as _pair, index (index)}
		<div class="flex items-center gap-2">
			<Input bind:value={pairs[index].key} placeholder={keyPlaceholder} class={FIELD_CLASS} {disabled} />
			<span class="flex-none text-[12.5px] text-zinc-600">=</span>
			<Input bind:value={pairs[index].value} placeholder={valuePlaceholder} class={FIELD_CLASS} {disabled} />
			<button
				type="button"
				class="flex size-9 flex-none items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-50"
				aria-label="Remove pair"
				{disabled}
				onclick={() => (pairs = pairs.filter((_, i) => i !== index))}
			>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
			</button>
		</div>
	{/each}

	<button
		type="button"
		class="flex h-9 w-fit items-center gap-[7px] rounded-lg border border-dashed border-line-strong px-3 text-[12.5px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-50"
		{disabled}
		onclick={() => (pairs = [...pairs, { key: '', value: '' }])}
	>
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
		{addLabel}
	</button>
</div>
